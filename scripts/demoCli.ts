import * as readline from "node:readline";
import { DeterministicExtractor } from "../src/extractor.js";
import { formatPayPalInvoiceV2Payload } from "../src/schema.js";
import { newFlow, approveDraft, recordDraftCreated, approveSend, recordSent } from "../src/approval.js";

const sampleChat = `Hey Maya!
Finished the responsive redesign for your web app.
Total as agreed is $450 USD.
Please send the invoice to maya@techstudio.test when ready! Net 14 works.`;

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function runCli() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("==================================================");
  console.log("   FREELANCE INVOICE COPILOT — LOCAL CLI DEMO     ");
  console.log("==================================================\n");

  console.log("1. Input Sample Freelancer Chat / Note:");
  console.log("---------------------------------------");
  console.log(sampleChat);
  console.log("---------------------------------------\n");

  console.log("2. Running Extractor with Provenance Spans...");
  const extractor = new DeterministicExtractor();
  const draft = await extractor.extractInvoice(sampleChat);

  console.log("\n[Extracted Invoice Draft]");
  console.log(`- Recipient Email: ${draft.recipientEmail.value} (Span: "${draft.recipientEmail.sourceSpan?.text}")`);
  console.log(`- Recipient Name:  ${draft.recipientName.value} (Span: "${draft.recipientName.sourceSpan?.text}")`);
  console.log(`- Currency:        ${draft.currency.value} (Span: "${draft.currency.sourceSpan?.text}")`);
  console.log(`- Payment Term:    ${draft.paymentTerm.value} (Span: "${draft.paymentTerm.sourceSpan?.text}")`);
  console.log(`- Items:           ${draft.items[0].name} - ${draft.items[0].unit_amount.currency_code} ${draft.items[0].unit_amount.value}`);

  console.log("\n3. PayPal Invoicing v2 Formatted Payload:");
  const payload = formatPayPalInvoiceV2Payload(draft, "freelancer@myagency.test");
  console.log(JSON.stringify(payload, null, 2));

  let flow = newFlow();
  console.log(`\nFlow Stage: ${flow.stage}`);

  // Gate 1: Draft Approval
  const ansDraft = await prompt(rl, "\n[GATE 1] Approve creating PayPal DRAFT invoice? (y/N): ");
  if (ansDraft.trim().toLowerCase() !== "y") {
    console.log("Draft creation aborted by user. Safe exit.");
    rl.close();
    return;
  }

  flow = approveDraft(flow);
  const mockDraftId = "INV2-DRAFT-LOCAL-DEMO";
  flow = recordDraftCreated(flow, mockDraftId);
  console.log(`✓ Draft approved & recorded. Stage: ${flow.stage} (ID: ${mockDraftId})`);

  // Gate 2: Send Approval
  const ansSend = await prompt(rl, "\n[GATE 2] Review draft details above. Approve SENDING to client? (y/N): ");
  if (ansSend.trim().toLowerCase() !== "y") {
    console.log("Sending aborted by user. Draft remains unsent and editable in dashboard.");
    rl.close();
    return;
  }

  flow = approveSend(flow);
  flow = recordSent(flow);
  console.log(`✓ Invoice marked sent! Final Flow Stage: ${flow.stage}`);
  console.log("\nAll actions respected the two-step human approval boundary.");
  rl.close();
}

runCli();
