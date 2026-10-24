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
    expect(session.unresolvedQuestions.length).toBeGreaterThanOrEqual(2);
  });

  it("blocks Gate 1 (approveAndCreateDraft) if required fields (email or currency) are missing or ambiguous", async () => {
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

    const session = await service.createSessionFromText(
      "Hi Alex, total is 500 for the logo design."
    );

    await expect(service.approveAndCreateDraft(session.id)).rejects.toThrow(
      /resolve missing or ambiguous required fields/i
    );
    expect(createDraftSpy).not.toHaveBeenCalled();
  });

  it("enforces Gate 1 (create draft) before Gate 2 (send invoice) and supports full lifecycle through PAID", async () => {
    const service = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: new RecordedPayPalGateway(),
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
    });

    // 1. Start with ambiguous currency & missing due date
    const session = await service.createSessionFromText(
      "Hi Maya, finished the dashboard UI for 450. Send invoice to maya@studio.test."
    );

    // Cannot send before draft exists
    await expect(service.approveAndSendInvoice(session.id)).rejects.toThrow(
      /A draft must exist first/i
    );

    // 2. Freelancer resolves currency and payment term via updateDraft
    const updated = service.updateDraft(session.id, {
      currency: "USD",
      paymentTerm: "NET_14",
      dueDate: "2026-11-15",
    });
    expect(updated.draft.currency.value).toBe("USD");
    expect(updated.draft.currency.isAmbiguous).toBe(false);
    expect(updated.unresolvedQuestions).toHaveLength(0);

    // 3. Gate 1: Approve & create draft in PayPal
    const afterDraft = await service.approveAndCreateDraft(session.id);
    expect(afterDraft.flow.stage).toBe("draft_created");
    expect(afterDraft.flow.draftApprovedAt).toBeTruthy();
    expect(afterDraft.flow.sentApprovedAt).toBeUndefined();
    expect(afterDraft.paypalInvoice?.status).toBe("DRAFT");
    expect(afterDraft.paypalInvoice?.id).toMatch(/^INV2-/);

    // 4. Gate 2: Approve & send invoice to client
    const afterSend = await service.approveAndSendInvoice(session.id);
    expect(afterSend.flow.stage).toBe("sent");
    expect(afterSend.flow.sentApprovedAt).toBeTruthy();
    expect(afterSend.paypalInvoice?.status).toBe("SENT");
    expect(afterSend.paypalInvoice?.recipientViewUrl).toContain("paypal.com/invoice/p/#");

    // 5. Simulate buyer payment in recorded sandbox mode
    const afterPay = await service.simulateSandboxPayment(session.id);
    expect(afterPay.paypalInvoice?.status).toBe("PAID");
  });
});
