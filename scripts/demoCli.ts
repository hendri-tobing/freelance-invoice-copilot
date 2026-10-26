import * as readline from "node:readline";
import { DeterministicExtractor } from "../src/extractor.js";
import { InvoiceWorkflowService, RecordedPayPalGateway } from "../src/workflow.js";

const sampleChat = `Client: Jordan Patel <jordan@brightwave.test>
Approved deliverables for BrightWave web relaunch:
1. Discovery & UX Audit: $400 USD
2. Responsive Webflow Implementation: $850 USD
Payment terms: Net 14. Send over the invoice when ready!`;

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

  const workflow = new InvoiceWorkflowService({
    extractor: new DeterministicExtractor(),
    paypal: new RecordedPayPalGateway(),
    extractionMode: "deterministic",
    paypalMode: "recorded_sandbox",
    invoicerEmail: "freelancer@myagency.test",
  });

  console.log("2. Running Extractor with Provenance Spans...");
  let session = await workflow.createSessionFromText(sampleChat);
  const draft = session.draft;

  console.log("\n[Extracted Invoice Draft]");
  console.log(`- Recipient Email: ${draft.recipientEmail.value} (Quote: "${draft.recipientEmail.sourceSpan?.text ?? "—"}")`);
  console.log(`- Recipient Name:  ${draft.recipientName.value} (Quote: "${draft.recipientName.sourceSpan?.text ?? "—"}")`);
  console.log(`- Currency:        ${draft.currency.value} (Quote: "${draft.currency.sourceSpan?.text ?? "—"}")`);
  console.log(`- Payment Term:    ${draft.paymentTerm.value ?? draft.dueDate.value} (Quote: "${draft.paymentTerm.sourceSpan?.text ?? draft.dueDate.sourceSpan?.text ?? "—"}")`);
  console.log(`- Line Items (${draft.items.length}):`);
  for (const [idx, item] of draft.items.entries()) {
    console.log(
      `   ${idx + 1}. ${item.name} — ${item.quantity} x ${item.unit_amount.currency_code} ${item.unit_amount.value} (Quote: "${item.sourceSpan?.text ?? "—"}")`
    );
  }

  console.log("\n3. PayPal Invoicing v2 Formatted Payload:");
  console.log(JSON.stringify(session.formattedPayPalPayload, null, 2));
  console.log(`\nFlow Stage: ${session.flow.stage}`);

  // Gate 1: Draft Approval
  const ansDraft = await prompt(rl, "\n[GATE 1] Approve creating PayPal DRAFT invoice? (y/N): ");
  if (ansDraft.trim().toLowerCase() !== "y") {
    console.log("Draft creation aborted by user. Safe exit.");
    rl.close();
    return;
  }

  session = await workflow.approveAndCreateDraft(session.id);
  console.log(
    `✓ Draft approved & created. Stage: ${session.flow.stage} (PayPal ID: ${session.paypalInvoice?.id}, Status: ${session.paypalInvoice?.status})`
  );

  // Gate 2: Send Approval
  const ansSend = await prompt(
    rl,
    `\n[GATE 2] Confirm sending invoice (${session.paypalInvoice?.id}) to ${draft.recipientEmail.value}? (y/N): `
  );
  if (ansSend.trim().toLowerCase() !== "y") {
    console.log("Sending aborted by user. Draft remains unsent and editable in dashboard.");
    rl.close();
    return;
  }

  session = await workflow.approveAndSendInvoice(session.id);
  console.log(
    `✓ Invoice sent! Stage: ${session.flow.stage} (PayPal Status: ${session.paypalInvoice?.status})`
  );
  console.log(`  Hosted Payer URL: ${session.paypalInvoice?.recipientViewUrl}`);
  console.log("\nAll actions respected the two-step human approval boundary.");
  rl.close();
}

runCli();
