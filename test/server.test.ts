import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAppServer } from "../src/server.js";
import { InvoiceWorkflowService, RecordedPayPalGateway } from "../src/workflow.js";
import { DeterministicExtractor } from "../src/extractor.js";

describe("HTTP API & Web UI Server (src/server.ts)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const workflow = new InvoiceWorkflowService({
      extractor: new DeterministicExtractor(),
      paypal: new RecordedPayPalGateway(),
      extractionMode: "deterministic",
      paypalMode: "recorded_sandbox",
      invoicerEmail: "freelancer@demo.test",
    });

    server = createAppServer(workflow);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("GET /api/config returns active modes and sample scenarios", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.modes.extractionMode).toBe("deterministic");
    expect(data.modes.paypalMode).toBe("recorded_sandbox");
    expect(Array.isArray(data.scenarios)).toBe(true);
    expect(data.scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it("executes full guarded workflow via REST endpoints and rejects out-of-order approvals", async () => {
    // 1. Extract ambiguous text
    const extractRes = await fetch(`${baseUrl}/api/sessions/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rawText:
          "Hey Maya! Finished the responsive redesign for 450. Send invoice to maya@techstudio.test.",
      }),
    });
    expect(extractRes.status).toBe(201);
    const session = await extractRes.json();
    expect(session.id).toBeTruthy();
    expect(session.flow.stage).toBe("proposed");
    expect(session.draft.currency.isAmbiguous).toBe(true);

    // 2. Attempting Gate 1 before resolving currency must return 400
    const prematureDraft = await fetch(
      `${baseUrl}/api/sessions/${session.id}/approve-draft`,
      { method: "POST" }
    );
    expect(prematureDraft.status).toBe(400);

    // 3. Attempting Gate 2 before Gate 1 must return 409
    const prematureSend = await fetch(
      `${baseUrl}/api/sessions/${session.id}/approve-send`,
      { method: "POST" }
    );
    expect(prematureSend.status).toBe(409);

    // 4. Resolve ambiguity via PATCH /draft
    const patchRes = await fetch(`${baseUrl}/api/sessions/${session.id}/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currency: "USD",
        paymentTerm: "NET_14",
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.draft.currency.value).toBe("USD");
    expect(patched.unresolvedQuestions).toHaveLength(0);

    // 5. Gate 1: Approve & Create Draft
    const draftRes = await fetch(
      `${baseUrl}/api/sessions/${session.id}/approve-draft`,
      { method: "POST" }
    );
    expect(draftRes.status).toBe(200);
    const afterDraft = await draftRes.json();
    expect(afterDraft.flow.stage).toBe("draft_created");
    expect(afterDraft.paypalInvoice.status).toBe("DRAFT");

    // 6. Gate 2: Approve & Send Invoice
    const sendRes = await fetch(
      `${baseUrl}/api/sessions/${session.id}/approve-send`,
      { method: "POST" }
    );
    expect(sendRes.status).toBe(200);
    const afterSend = await sendRes.json();
    expect(afterSend.flow.stage).toBe("sent");
    expect(afterSend.paypalInvoice.status).toBe("SENT");
    expect(afterSend.lastDraftedReminder).toBeTruthy();

    // 6b. Gate 3: Draft Reminder & Approve + Send Reminder via REST endpoints
    const draftRemindRes = await fetch(
      `${baseUrl}/api/sessions/${session.id}/remind/draft`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tone: "professional" }),
      }
    );
    expect(draftRemindRes.status).toBe(200);
    const draftedRemind = await draftRemindRes.json();
    expect(draftedRemind.tone).toBe("professional");
    expect(draftedRemind.subject).toContain("USD 450.00");

    const sendRemindRes = await fetch(
      `${baseUrl}/api/sessions/${session.id}/remind/approve-send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: draftedRemind.subject,
          note: draftedRemind.note,
          tone: "professional",
        }),
      }
    );
    expect(sendRemindRes.status).toBe(200);
    const afterRemind = await sendRemindRes.json();
    expect(afterRemind.reminders).toHaveLength(1);
    expect(afterRemind.reminders[0].tone).toBe("professional");

    // 7. Simulate Sandbox Payment
    const payRes = await fetch(
      `${baseUrl}/api/sessions/${session.id}/simulate-pay`,
      { method: "POST" }
    );
    expect(payRes.status).toBe(200);
    const afterPay = await payRes.json();
    expect(afterPay.paypalInvoice.status).toBe("PAID");

    // 8. Attempting Gate 3 reminder after PAID must return 409
    const postPayRemind = await fetch(
      `${baseUrl}/api/sessions/${session.id}/remind/approve-send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: draftedRemind.subject,
          note: draftedRemind.note,
          tone: "professional",
        }),
      }
    );
    expect(postPayRemind.status).toBe(409);
  });

  it("preserves provenance on remaining line item when item 1 is removed via PATCH /api/sessions/:id/draft and rejects invalid quantity", async () => {
    const extractRes = await fetch(`${baseUrl}/api/sessions/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rawText: [
          "Client: Jordan Patel <jordan@brightwave.io>",
          "1. Discovery & UX Audit: $400 USD",
          "2. Design System Kit: $800 USD",
          "3. Revisions: included",
          "Payment terms: Net 14.",
        ].join("\n"),
      }),
    });
    expect(extractRes.status).toBe(201);
    const session = await extractRes.json();
    expect(session.draft.items).toHaveLength(3);
    expect(session.draft.items[2].isAmbiguous).toBe(true);
    const originalItem2Span = session.draft.items[1].sourceSpan;
    expect(originalItem2Span.text).toContain("Design System Kit");

    // Attempting Gate 1 while item 3 ("Revisions: included") is unpriced/ambiguous must return 400
    const blockedApprove = await fetch(
      `${baseUrl}/api/sessions/${session.id}/approve-draft`,
      { method: "POST" }
    );
    expect(blockedApprove.status).toBe(400);

    // User removes item 1 and item 3, keeping only item 2 ("Design System Kit")
    const patchKeepItem2 = await fetch(`${baseUrl}/api/sessions/${session.id}/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            name: "Design System Kit",
            quantity: "1",
            unitPrice: "800.00",
            sourceSpan: originalItem2Span,
          },
        ],
      }),
    });
    expect(patchKeepItem2.status).toBe(200);
    const afterKeep = await patchKeepItem2.json();
    expect(afterKeep.draft.items).toHaveLength(1);
    expect(afterKeep.draft.items[0].name).toBe("Design System Kit");
    expect(afterKeep.draft.items[0].sourceSpan.text).toBe(originalItem2Span.text);

    // Setting quantity to "0" must block Gate 1 on the server
    await fetch(`${baseUrl}/api/sessions/${session.id}/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            name: "Design System Kit",
            quantity: "0",
            unitPrice: "800.00",
          },
        ],
      }),
    });
    const zeroQtyApprove = await fetch(
      `${baseUrl}/api/sessions/${session.id}/approve-draft`,
      { method: "POST" }
    );
    expect(zeroQtyApprove.status).toBe(400);
  });

  it("serves static assets at GET / and maps error codes by error class rather than message substring", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const cssRes = await fetch(`${baseUrl}/styles.css`);
    expect(cssRes.status).toBe(200);

    const jsRes = await fetch(`${baseUrl}/app.js`);
    expect(jsRes.status).toBe(200);

    // Non-existent session returns 404 via NotFoundError
    const missingRes = await fetch(`${baseUrl}/api/sessions/non-existent-id`);
    expect(missingRes.status).toBe(404);

    // Invalid JSON or validation failure returns 400, not 404
    const badPatchRes = await fetch(`${baseUrl}/api/sessions/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText: "" }),
    });
    expect(badPatchRes.status).toBe(400);
  });
});
