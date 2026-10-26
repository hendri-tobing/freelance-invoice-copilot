import { describe, it, expect, beforeEach } from "vitest";
import { InvoiceWorkflowService, RecordedPayPalGateway } from "../src/workflow.js";
import { DeterministicExtractor } from "../src/extractor.js";
import {
  getUiState,
  setUiStateForTest,
  confirmDiscardIfDirty,
  removeLineItemAt,
  updateLineItemField,
  getFormMissingReasons,
  buildPatchFromForm,
  setActiveHighlightField,
  openGate2ConfirmDialog,
  closeGate2ConfirmDialog,
  openGate3ConfirmDialog,
  closeGate3ConfirmDialog,
} from "../public/app.js";

function createService() {
  return new InvoiceWorkflowService({
    extractor: new DeterministicExtractor(),
    paypal: new RecordedPayPalGateway(),
    extractionMode: "deterministic",
    paypalMode: "recorded_sandbox",
    invoicerEmail: "freelancer@demo.test",
  });
}

describe("Frontend UI Controller Behavior (public/app.js)", () => {
  let workflow: InvoiceWorkflowService;

  beforeEach(() => {
    workflow = createService();
    setUiStateForTest({
      currentSession: null,
      editableItems: [],
      isFormDirty: false,
      activeHighlightField: null,
    });
  });

  it("removes line item 1 of 2 and preserves line item 2 provenance through buildPatchFromForm -> workflow.updateDraft", async () => {
    const session = await workflow.createSessionFromText(
      [
        "Client: Jordan Patel <jordan@brightwave.io>",
        "1. Discovery & UX Audit: $400 USD",
        "2. Design System Kit: $800 USD",
        "Payment terms: Net 14.",
      ].join("\n")
    );

    const editableItems = session.draft.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unit_amount.value,
      sourceSpan: item.sourceSpan,
      isAmbiguous: item.isAmbiguous ?? false,
      clarificationQuestion: item.clarificationQuestion ?? null,
    }));

    setUiStateForTest({
      currentSession: session,
      editableItems,
      isFormDirty: false,
    });

    const item2OriginalQuote = editableItems[1].sourceSpan?.text;
    expect(item2OriginalQuote).toContain("Design System Kit");

    // User clicks "Remove" on item 0 (Item 1)
    const removed = removeLineItemAt(0, false);
    expect(removed).toBe(true);

    const stateAfterRemove = getUiState();
    expect(stateAfterRemove.isFormDirty).toBe(true);
    expect(stateAfterRemove.editableItems).toHaveLength(1);
    expect(stateAfterRemove.editableItems[0].name).toBe("Design System Kit");
    expect(stateAfterRemove.editableItems[0].sourceSpan?.text).toBe(item2OriginalQuote);

    // Build patch from form state and apply to backend workflow
    const patch = buildPatchFromForm();
    const updatedSession = workflow.updateDraft(session.id, patch);

    expect(updatedSession.draft.items).toHaveLength(1);
    expect(updatedSession.draft.items[0].name).toBe("Design System Kit");
    expect(updatedSession.draft.items[0].sourceSpan?.text).toBe(item2OriginalQuote);
  });

  it("clears sourceSpan and resolves item ambiguity when user edits an unparsed list item price", async () => {
    const session = await workflow.createSessionFromText(
      [
        "Client: Jordan Patel <jordan@brightwave.io>",
        "1. Discovery & UX Audit: $400 USD",
        "2. Revisions: included",
        "Payment terms: Net 14.",
      ].join("\n")
    );

    const editableItems = session.draft.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unit_amount.value,
      sourceSpan: item.sourceSpan,
      isAmbiguous: item.isAmbiguous ?? false,
      clarificationQuestion: item.clarificationQuestion ?? null,
    }));

    setUiStateForTest({
      currentSession: session,
      editableItems,
      isFormDirty: false,
    });

    // Initially item 2 ("Revisions: included") is ambiguous and blocks Gate 1
    expect(getFormMissingReasons().some((r) => r.includes("Unclear Line Item"))).toBe(true);

    // User edits item 2 unitPrice to $150.00
    updateLineItemField(1, "unitPrice", "150.00");

    const stateAfterEdit = getUiState();
    expect(stateAfterEdit.isFormDirty).toBe(true);
    expect(stateAfterEdit.editableItems[1].sourceSpan).toBeNull();
    expect(stateAfterEdit.editableItems[1].isAmbiguous).toBe(false);
    expect(getFormMissingReasons()).toHaveLength(0);

    // Applying patch to backend resolves all questions and allows Gate 1
    const updatedSession = workflow.updateDraft(session.id, buildPatchFromForm());
    expect(updatedSession.unresolvedQuestions).toHaveLength(0);
    expect(updatedSession.draft.items[1].sourceSpan).toBeNull();
  });

  it("dirty guard confirmDiscardIfDirty blocks Step 1 scenario/extract replacement when user cancels", async () => {
    const session = await workflow.createSessionFromText(
      "Client: Jordan Patel <jordan@brightwave.io>\n1. Audit: $400 USD\nNet 14."
    );

    setUiStateForTest({
      currentSession: session,
      editableItems: [
        {
          name: "Audit",
          quantity: "1",
          unitPrice: "400.00",
          sourceSpan: null,
          isAmbiguous: false,
        },
      ],
      isFormDirty: false,
    });

    // Clean form does not prompt
    let promptCount = 0;
    expect(
      confirmDiscardIfDirty(() => {
        promptCount++;
        return false;
      })
    ).toBe(true);
    expect(promptCount).toBe(0);

    // User makes an unsaved edit in Step 2
    updateLineItemField(0, "unitPrice", "450.00");
    expect(getUiState().isFormDirty).toBe(true);

    // User clicks a scenario button or Extract in Step 1 and cancels the confirmation prompt
    const allowedWhenCancelled = confirmDiscardIfDirty((msg) => {
      promptCount++;
      expect(msg).toContain("unsaved edits in Step 2");
      return false;
    });
    expect(allowedWhenCancelled).toBe(false);
    expect(promptCount).toBe(1);

    // User confirms discarding edits
    const allowedWhenConfirmed = confirmDiscardIfDirty(() => {
      promptCount++;
      return true;
    });
    expect(allowedWhenConfirmed).toBe(true);
    expect(promptCount).toBe(2);
  });

  it("setActiveHighlightField toggles .active class on <mark> elements in-place without replacing innerHTML", async () => {
    const session = await workflow.createSessionFromText(
      "Client: Jordan Patel <jordan@brightwave.io>\n1. Audit: $400 USD\nNet 14."
    );

    // Create minimal mock DOM for #highlighted-source and #active-span-meta
    const emailMark = {
      field: "recipientEmail",
      active: false,
      getAttribute(attr: string) {
        return attr === "data-field" ? this.field : null;
      },
      classList: {
        toggle(cls: string, force: boolean) {
          if (cls === "active") emailMark.active = force;
        },
      },
    };
    const itemMark = {
      field: "items",
      active: false,
      getAttribute(attr: string) {
        return attr === "data-field" ? this.field : null;
      },
      classList: {
        toggle(cls: string, force: boolean) {
          if (cls === "active") itemMark.active = force;
        },
      },
    };
    let innerHtmlWriteCount = 0;
    const containerMock = {
      get innerHTML() {
        return "<mark>mock</mark>";
      },
      set innerHTML(_val: string) {
        innerHtmlWriteCount++;
      },
      querySelectorAll(selector: string) {
        return selector === ".source-mark" ? [emailMark, itemMark] : [];
      },
    };
    const metaMock = { textContent: "" };

    const origDocument = globalThis.document;
    globalThis.document = {
      getElementById(id: string) {
        if (id === "highlighted-source") return containerMock;
        if (id === "active-span-meta") return metaMock;
        return null;
      },
    } as unknown as Document;

    try {
      setUiStateForTest({
        currentSession: session,
        editableItems: [],
        isFormDirty: false,
      });

      setActiveHighlightField("recipientEmail");
      expect(innerHtmlWriteCount).toBe(0);
      expect(emailMark.active).toBe(true);
      expect(itemMark.active).toBe(false);
      expect(metaMock.textContent).toContain("jordan@brightwave.io");

      setActiveHighlightField("items");
      expect(innerHtmlWriteCount).toBe(0);
      expect(emailMark.active).toBe(false);
      expect(itemMark.active).toBe(true);
    } finally {
      globalThis.document = origDocument;
    }
  });

  it("openGate2ConfirmDialog and closeGate2ConfirmDialog operate native <dialog> via showModal() and close()", async () => {
    const proposedSession = await workflow.createSessionFromText(
      "Client: Jordan Patel <jordan@brightwave.io>\n1. Audit: $400 USD\nNet 14."
    );
    const session = await workflow.approveAndCreateDraft(proposedSession.id);

    let modalOpened = false;
    let modalClosed = false;
    let triggerFocused = false;

    const dialogMock = {
      open: false,
      showModal() {
        modalOpened = true;
        this.open = true;
      },
      close() {
        modalClosed = true;
        this.open = false;
      },
    };
    const recipientEl = { textContent: "" };
    const amountEl = { textContent: "" };
    const termsEl = { textContent: "" };
    const sendBtnMock = {
      focus() {
        triggerFocused = true;
      },
    };

    const origDocument = globalThis.document;
    globalThis.document = {
      getElementById(id: string) {
        if (id === "gate2-confirm-dialog") return dialogMock;
        if (id === "confirm-recipient") return recipientEl;
        if (id === "confirm-amount") return amountEl;
        if (id === "confirm-terms") return termsEl;
        if (id === "btn-approve-send") return sendBtnMock;
        return null;
      },
    } as unknown as Document;

    try {
      setUiStateForTest({
        currentSession: session,
        editableItems: [
          {
            name: "Audit",
            quantity: "1",
            unitPrice: "400.00",
            sourceSpan: null,
            isAmbiguous: false,
          },
        ],
        isFormDirty: false,
      });

      openGate2ConfirmDialog();
      expect(modalOpened).toBe(true);
      expect(dialogMock.open).toBe(true);
      expect(recipientEl.textContent).toContain("jordan@brightwave.io");
      expect(amountEl.textContent).toContain("USD $400.00");
      expect(termsEl.textContent).toBe("Net 14 (14 days)");

      closeGate2ConfirmDialog();
      expect(modalClosed).toBe(true);
      expect(dialogMock.open).toBe(false);
      expect(triggerFocused).toBe(true);
    } finally {
      globalThis.document = origDocument;
    }
  });

  it("openGate3ConfirmDialog and closeGate3ConfirmDialog operate native <dialog> when invoice is SENT and block when PAID", async () => {
    const proposed = await workflow.createSessionFromText(
      "Client: Jordan Patel <jordan@brightwave.io>\n1. Audit: $400 USD\nNet 14."
    );
    await workflow.approveAndCreateDraft(proposed.id);
    const sentSession = await workflow.approveAndSendInvoice(proposed.id);

    let modalOpened = false;
    let modalClosed = false;
    let triggerFocused = false;

    const dialogMock = {
      open: false,
      showModal() {
        modalOpened = true;
        this.open = true;
      },
      close() {
        modalClosed = true;
        this.open = false;
      },
    };
    const recipientEl = { textContent: "" };
    const toneEl = { textContent: "" };
    const subjectEl = { textContent: "" };
    const subjectInputEl = { value: "Friendly check-in: Invoice INV2-SIM" };
    const remindBtnMock = {
      focus() {
        triggerFocused = true;
      },
    };

    const origDocument = globalThis.document;
    globalThis.document = {
      getElementById(id: string) {
        if (id === "gate3-confirm-dialog") return dialogMock;
        if (id === "confirm-remind-recipient") return recipientEl;
        if (id === "confirm-remind-tone") return toneEl;
        if (id === "confirm-remind-subject") return subjectEl;
        if (id === "input-reminder-subject") return subjectInputEl;
        if (id === "btn-approve-reminder") return remindBtnMock;
        return null;
      },
    } as unknown as Document;

    try {
      setUiStateForTest({
        currentSession: sentSession,
        activeReminderTone: "urgent",
      });

      const opened = openGate3ConfirmDialog();
      expect(opened).toBe(true);
      expect(modalOpened).toBe(true);
      expect(recipientEl.textContent).toContain("jordan@brightwave.io");
      expect(toneEl.textContent).toBe("Urgent");
      expect(subjectEl.textContent).toBe("Friendly check-in: Invoice INV2-SIM");

      closeGate3ConfirmDialog();
      expect(modalClosed).toBe(true);
      expect(triggerFocused).toBe(true);

      // Simulate buyer payment -> openGate3ConfirmDialog must return false when PAID
      const paidSession = await workflow.simulateSandboxPayment(sentSession.id);
      setUiStateForTest({ currentSession: paidSession });
      expect(openGate3ConfirmDialog()).toBe(false);
    } finally {
      globalThis.document = origDocument;
    }
  });
});
