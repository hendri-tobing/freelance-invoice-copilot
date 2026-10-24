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

    // 7. Simulate Sandbox Payment
    const payRes = await fetch(
      `${baseUrl}/api/sessions/${session.id}/simulate-pay`,
      { method: "POST" }
    );
    expect(payRes.status).toBe(200);
    const afterPay = await payRes.json();
    expect(afterPay.paypalInvoice.status).toBe("PAID");
  });

  it("serves the Single-Page Web UI at GET /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Freelance Invoice Copilot");
  });
});
