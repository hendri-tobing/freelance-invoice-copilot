import { describe, it, expect, vi } from "vitest";
import {
  InvoiceWorkflowService,
  RecordedPayPalGateway,
  PayPalGateway,
} from "../src/workflow.js";
import { DeterministicExtractor } from "../src/extractor.js";

describe("InvoiceWorkflowService — Guarded Two-Step Approval Orchestrator", () => {
  it("extracts a message into a session at 'proposed' stage with unresolved questions when ambiguous", async () => {
    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: new RecordedPayPalGateway(),
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(
      "Hi Alex, finished the API integration for 750. Let me know where to send the invoice."
    );

    expect(session.flow.stage).toBe("proposed");
    expect(session.draft.recipientEmail.value).toBeNull();
    expect(session.draft.recipientEmail.isAmbiguous).toBe(true);
    expect(session.draft.currency.value).toBeNull();
    expect(session.draft.currency.isAmbiguous).toBe(true);
    expect(session.draft.paymentTerm.value).toBeNull();
    expect(session.draft.paymentTerm.isAmbiguous).toBe(true);
    expect(session.unresolvedQuestions.length).toBeGreaterThanOrEqual(3);
  });

  it("blocks Gate 1 (approveAndCreateDraft) if paymentTerm and dueDate are unresolved even when email and currency are present", async () => {
    const createDraftSpy = vi.fn();
    const mockGateway: PayPalGateway = {
      createDraftInvoice: createDraftSpy,
      getInvoice: vi.fn(),
      sendInvoice: vi.fn(),
    };

    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: mockGateway,
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    // Email and USD are present, but no payment term or due date is stated
    const session = await service.createSessionFromText(
      "Hi Alex, total is $500 USD for the logo design. Send to alex@studio.test."
    );

    await expect(service.approveAndCreateDraft(session.id)).rejects.toThrow(
      /paymentTerm/i
    );
    expect(createDraftSpy).not.toHaveBeenCalled();
  });

  it("prevents concurrent double-approvals for both Gate 1 (draft) and Gate 2 (send)", async () => {
    let draftCalls = 0;
    let sendCalls = 0;

    const slowGateway: PayPalGateway = {
      createDraftInvoice: vi.fn(async () => {
        draftCalls++;
        await new Promise((r) => setTimeout(r, 25));
        return { id: "INV2-SLOW-1", status: "DRAFT" };
      }),
      getInvoice: vi.fn(async (id: string) => ({
        id,
        status: sendCalls > 0 ? "SENT" : "DRAFT",
      })),
      sendInvoice: vi.fn(async () => {
        sendCalls++;
        await new Promise((r) => setTimeout(r, 25));
        return { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-SLOW-1" };
      }),
    };

    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: slowGateway,
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(
      "Hi Sarah, $1,200 USD net 30 to sarah@client.org for audit."
    );

    // Fire two concurrent Gate 1 calls (simulating double-click)
    const gate1Results = await Promise.allSettled([
      service.approveAndCreateDraft(session.id),
      service.approveAndCreateDraft(session.id),
    ]);

    const gate1Fulfilled = gate1Results.filter((r) => r.status === "fulfilled");
    const gate1Rejected = gate1Results.filter((r) => r.status === "rejected");
    expect(gate1Fulfilled).toHaveLength(1);
    expect(gate1Rejected).toHaveLength(1);
    expect(draftCalls).toBe(1);

    // Fire two concurrent Gate 2 calls (simulating double-click on send)
    const gate2Results = await Promise.allSettled([
      service.approveAndSendInvoice(session.id),
      service.approveAndSendInvoice(session.id),
    ]);

    const gate2Fulfilled = gate2Results.filter((r) => r.status === "fulfilled");
    const gate2Rejected = gate2Results.filter((r) => r.status === "rejected");
    expect(gate2Fulfilled).toHaveLength(1);
    expect(gate2Rejected).toHaveLength(1);
    expect(sendCalls).toBe(1);
  });

  it("reuses the same PayPal-Request-Id across retries if createDraftInvoice fails transiently", async () => {
    const requestIds: string[] = [];
    let attempt = 0;

    const flakyGateway: PayPalGateway = {
      createDraftInvoice: vi.fn(async (_payload, reqId) => {
        requestIds.push(reqId);
        attempt++;
        if (attempt === 1) {
          throw new Error("Transient network timeout");
        }
        return { id: "INV2-RETRY-OK", status: "DRAFT" };
      }),
      getInvoice: vi.fn(async (id: string) => ({ id, status: "DRAFT" })),
      sendInvoice: vi.fn(),
    };

    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: flakyGateway,
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(
      "Hi Sarah, $1,200 USD net 30 to sarah@client.org for audit."
    );

    await expect(service.approveAndCreateDraft(session.id)).rejects.toThrow(
      /Transient network timeout/
    );

    const recovered = await service.approveAndCreateDraft(session.id);
    expect(recovered.flow.stage).toBe("draft_created");
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  it("propagates getInvoice errors instead of swallowing them silently", async () => {
    const brokenGetGateway: PayPalGateway = {
      createDraftInvoice: vi.fn(async () => ({ id: "INV2-1", status: "DRAFT" })),
      getInvoice: vi.fn(async () => {
        throw new Error("PayPal GET /v2/invoicing/invoices/INV2-1 failed: HTTP 500");
      }),
      sendInvoice: vi.fn(),
    };

    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: brokenGetGateway,
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(
      "Hi Sarah, $1,200 USD net 30 to sarah@client.org for audit."
    );

    await expect(service.approveAndCreateDraft(session.id)).rejects.toThrow(/HTTP 500/);
  });

  it("enforces Gate 1 (create draft) before Gate 2 (send invoice) and supports full lifecycle through PAID", async () => {
    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: new RecordedPayPalGateway(),
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(
      "Hi Maya, finished the dashboard UI for 450. Send invoice to maya@studio.test."
    );

    await expect(service.approveAndSendInvoice(session.id)).rejects.toThrow(
      /A draft must exist first/i
    );

    const updated = service.updateDraft(session.id, {
      currency: "USD",
      paymentTerm: "NET_14",
      dueDate: "2026-11-15",
    });
    expect(updated.draft.currency.value).toBe("USD");
    expect(updated.draft.currency.isAmbiguous).toBe(false);
    expect(updated.unresolvedQuestions).toHaveLength(0);

    const afterDraft = await service.approveAndCreateDraft(session.id);
    expect(afterDraft.flow.stage).toBe("draft_created");
    expect(afterDraft.flow.draftApprovedAt).toBeTruthy();
    expect(afterDraft.flow.sentApprovedAt).toBeUndefined();
    expect(afterDraft.paypalInvoice?.status).toBe("DRAFT");
    expect(afterDraft.paypalInvoice?.id).toMatch(/^INV2-/);

    const afterSend = await service.approveAndSendInvoice(session.id);
    expect(afterSend.flow.stage).toBe("sent");
    expect(afterSend.flow.sentApprovedAt).toBeTruthy();
    expect(afterSend.paypalInvoice?.status).toBe("SENT");
    expect(afterSend.paypalInvoice?.recipientViewUrl).toContain("paypal.com/invoice/p/#");

    const afterPay = await service.simulateSandboxPayment(session.id);
    expect(afterPay.paypalInvoice?.status).toBe("PAID");
  });

  it("preserves the correct item sourceSpan when item 1 of 2 is removed, and clears sourceSpan when an item is edited", async () => {
    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: new RecordedPayPalGateway(),
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(`Hi Alex, project wrap-up:
1. Landing page design: $650 USD
2. Interactive prototype: $250 USD
Send invoice to alex@brightlabs.test Net 14.`);

    expect(session.draft.items).toHaveLength(2);
    const item2OriginalSpan = session.draft.items[1].sourceSpan;
    expect(item2OriginalSpan?.text).toContain("Interactive prototype: $250 USD");

    // Remove item 1 (index 0), keeping only item 2
    const afterRemove = service.updateDraft(session.id, {
      items: [
        {
          name: session.draft.items[1].name,
          quantity: session.draft.items[1].quantity,
          unitPrice: session.draft.items[1].unit_amount.value,
          sourceSpan: item2OriginalSpan,
        },
      ],
    });

    expect(afterRemove.draft.items).toHaveLength(1);
    expect(afterRemove.draft.items[0].name).toBe("Interactive prototype");
    // Must retain item 2's span, NOT item 1's span!
    expect(afterRemove.draft.items[0].sourceSpan?.text).toContain("Interactive prototype: $250 USD");

    // Now edit the price of the remaining item: sourceSpan must be cleared because user modified it
    const afterEdit = service.updateDraft(session.id, {
      items: [
        {
          name: "Interactive prototype",
          quantity: "1",
          unitPrice: "300",
          sourceSpan: item2OriginalSpan,
        },
      ],
    });
    expect(afterEdit.draft.items[0].sourceSpan).toBeNull();
  });

  it("enforces quantity > 0 and rejects ambiguous list items on the server before Gate 1 approval", async () => {
    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: new RecordedPayPalGateway(),
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(`Hi Alex:
1. Landing page: $500 USD
2. Hosting: $20/month
Send to alex@brightlabs.test Net 14.`);

    // Unresolved ambiguous line item #2 blocks Gate 1 and surfaces in unresolvedQuestions
    expect(session.unresolvedQuestions.some((q) => q.field.startsWith("items"))).toBe(true);
    await expect(service.approveAndCreateDraft(session.id)).rejects.toThrow(/ambiguous|clarification/i);

    // Setting quantity to 0 must also be rejected by Gate 1
    service.updateDraft(session.id, {
      items: [
        {
          name: "Landing page",
          quantity: "0",
          unitPrice: "500",
        },
      ],
    });
    await expect(service.approveAndCreateDraft(session.id)).rejects.toThrow(/quantity/i);
  });

  it("supports Gate 3 reminder drafting and guarded reminder sending with rate limiting and PAID protection", async () => {
    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: new RecordedPayPalGateway(),
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    const session = await service.createSessionFromText(
      "Hi Sarah, wrapping up the mobile checkout UI audit as agreed for $1,200 USD. Sending to sarah@fintech-client.test under Net 30 terms."
    );

    // Cannot draft or send reminder while still in 'proposed' stage
    await expect(service.draftReminder(session.id, "gentle")).rejects.toThrow(/sent/i);
    await expect(
      service.approveAndSendReminder(session.id, {
        subject: "Reminder",
        note: "Please pay",
        tone: "gentle",
      })
    ).rejects.toThrow(/sent/i);

    await service.approveAndCreateDraft(session.id);

    // Still cannot send reminder in 'draft_created' stage
    await expect(
      service.approveAndSendReminder(session.id, {
        subject: "Reminder",
        note: "Please pay",
        tone: "gentle",
      })
    ).rejects.toThrow(/sent/i);

    await service.approveAndSendInvoice(session.id);

    // Draft reminders in 3 tones
    const gentleDraft = await service.draftReminder(session.id, "gentle");
    expect(gentleDraft.tone).toBe("gentle");
    expect(gentleDraft.subject).toContain("USD 1200.00");
    expect(gentleDraft.note).toContain("Sarah");

    const urgentDraft = await service.draftReminder(session.id, "urgent");
    expect(urgentDraft.tone).toBe("urgent");
    expect(urgentDraft.subject).toMatch(/overdue|action required/i);

    // Send 1st reminder via Gate 3
    const afterRemind1 = await service.approveAndSendReminder(session.id, {
      subject: gentleDraft.subject,
      note: gentleDraft.note,
      tone: "gentle",
    });
    expect(afterRemind1.reminders).toHaveLength(1);
    expect(afterRemind1.reminders[0].tone).toBe("gentle");
    expect(afterRemind1.reminders[0].subject).toBe(gentleDraft.subject);

    // Send 2nd reminder on the same UTC day -> allowed
    const afterRemind2 = await service.approveAndSendReminder(session.id, {
      subject: urgentDraft.subject,
      note: urgentDraft.note,
      tone: "urgent",
    });
    expect(afterRemind2.reminders).toHaveLength(2);

    // 3rd reminder on the same UTC day -> blocked by anti-spam rate limit (max 2/day)
    await expect(
      service.approveAndSendReminder(session.id, {
        subject: "Third reminder today",
        note: "Spam check",
        tone: "urgent",
      })
    ).rejects.toThrow(/maximum of 2 reminders per day/i);

    // Once invoice is PAID, reminders are blocked even if daily limit wasn't reached
    const session2 = await service.createSessionFromText(
      "Hi Sarah, wrapping up the mobile checkout UI audit as agreed for $1,200 USD. Sending to sarah@fintech-client.test under Net 30 terms."
    );
    await service.approveAndCreateDraft(session2.id);
    await service.approveAndSendInvoice(session2.id);
    await service.simulateSandboxPayment(session2.id);

    await expect(
      service.approveAndSendReminder(session2.id, {
        subject: "Post-payment reminder",
        note: "Should not send",
        tone: "gentle",
      })
    ).rejects.toThrow(/PAID/i);
  });
});
