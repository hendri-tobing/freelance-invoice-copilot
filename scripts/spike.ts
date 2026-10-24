// Gate 1 spike: create draft -> separate send -> (buyer pays manually in sandbox) -> status.
// Run: npm run spike   (requires PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)
// Payload uses fictional data only.
import { loadConfig, PayPalClient } from "../src/paypal.js";
import { newFlow, approveDraft, recordDraftCreated, approveSend, recordSent } from "../src/approval.js";
import { randomUUID } from "node:crypto";

const fictionalInvoice = {
  detail: {
    currency_code: "USD",
    note: "Fictional spike invoice. Not a real client.",
    payment_term: { term_type: "NET_14" },
  },
  invoicer: { name: { given_name: "Spike", surname: "Freelancer" }, email_address: "sb-spike-seller@example.com" },
  primary_recipients: [
    { billing_info: { name: { given_name: "Maya", surname: "Fiktif" }, email_address: "sb-spike-buyer@example.com" } },
  ],
  items: [
    {
      name: "Landing page redesign (fictional)",
      quantity: "1",
      unit_amount: { currency_code: "USD", value: "450.00" },
    },
  ],
};

async function main() {
  const client = new PayPalClient(loadConfig());
  let flow = newFlow();

  // Approval 1: create draft
  flow = approveDraft(flow);
  const draft = await client.createDraftInvoice(fictionalInvoice, randomUUID());
  flow = recordDraftCreated(flow, draft.id);
  console.log("DRAFT created:", draft.id, draft.status ?? "");

  const afterDraft = await client.getInvoice(draft.id);
  console.log("Status after draft:", afterDraft.status);

  // Approval 2: send (separate, explicit)
  flow = approveSend(flow);
  const sent = await client.sendInvoice(draft.id);
  flow = recordSent(flow);
  console.log("SENT:", JSON.stringify(sent).slice(0, 300));

  const afterSend = await client.getInvoice(draft.id);
  console.log("Status after send:", afterSend.status);
  console.log("Next: open the hosted invoice as a sandbox buyer, pay, then run `npm run status -- " + draft.id + "`");
  console.log("Flow stage:", flow.stage);
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
