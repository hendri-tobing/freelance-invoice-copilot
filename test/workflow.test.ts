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
});
