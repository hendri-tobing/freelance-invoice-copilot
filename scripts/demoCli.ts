import * as readline from "node:readline";
import { MAX_REMINDERS_PER_DAY, ReminderTone } from "../src/approval.js";
import { DeterministicExtractor } from "../src/extractor.js";
import { InvoiceWorkflowService, RecordedPayPalGateway } from "../src/workflow.js";

const sampleChat = `Client: Kofi Nowakowski <kofi@brightwave.test>
Approved deliverables for BrightWave web relaunch:
1. Discovery & UX Audit: $400 USD
2. Responsive Webflow Implementation: $850 USD
Payment terms: Net 14. Send over the invoice when ready!`;

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function parseToneChoice(input: string): ReminderTone {
  const val = input.trim().toLowerCase();
  if (val === "2" || val === "professional") return "professional";
  if (val === "3" || val === "urgent") return "urgent";
  return "gentle";
}

async function runCli() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("==================================================");
  console.log("FREELANCE INVOICE COPILOT — LOCAL CLI DEMO");
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

  // Gate 3: Follow-up & Reminder Copilot
  console.log("\n4. Follow-up & Reminder Copilot (Gate 3):");
  console.log("---------------------------------------");
  const toneInput = await prompt(
    rl,
    "Choose reminder tone [1=gentle (default), 2=professional, 3=urgent]: "
  );
  const selectedTone = parseToneChoice(toneInput);
  const draftedReminder = await workflow.draftReminder(session.id, selectedTone);

  console.log("\n[Drafted Reminder Preview]");
  console.log(`- Recipient: ${draft.recipientName.value ?? "Client"} <${draft.recipientEmail.value}>`);
  console.log(`- Tone:      ${draftedReminder.tone}`);
  console.log(`- Subject:   ${draftedReminder.subject}`);
  console.log(`- Note:      ${draftedReminder.note}`);

  let reminderOutcome = "skipped";
  const ansRemind = await prompt(
    rl,
    `\n[GATE 3] Approve sending this reminder email to ${draft.recipientEmail.value}? (y/N): `
  );
  if (ansRemind.trim().toLowerCase() === "y") {
    session = await workflow.approveAndSendReminder(session.id, {
      subject: draftedReminder.subject,
      note: draftedReminder.note,
      tone: selectedTone,
    });
    reminderOutcome = `sent (${session.reminders.length}/${MAX_REMINDERS_PER_DAY} daily limit)`;
    console.log(
      `✓ Reminder sent! Reminders used today: ${session.reminders.length}/${MAX_REMINDERS_PER_DAY}.`
    );
  } else {
    console.log("✓ Reminder skipped by user.");
  }

  // Optional Sandbox Buyer Payment Simulation (clearly labeled outside the approval gates)
  let paymentOutcome = "not simulated (invoice remains SENT)";
  const ansPay = await prompt(
    rl,
    "\n[SANDBOX SIMULATION] Simulate the buyer paying this invoice now? (y/N): "
  );
  if (ansPay.trim().toLowerCase() === "y") {
    session = await workflow.simulateSandboxPayment(session.id);
    paymentOutcome = "simulated (invoice is now PAID)";
    console.log(`✓ Payment recorded! PayPal Invoice Status: ${session.paypalInvoice?.status}`);
    console.log(
      "✓ Follow-up reminders are now locked because this invoice has been paid in full."
    );
  } else {
    console.log("✓ Payment simulation skipped; invoice remains SENT.");
  }

  console.log(
    `\n✓ Demo complete — Draft: created | Invoice: sent | Gate 3 Reminder: ${reminderOutcome} | Buyer Payment: ${paymentOutcome}.`
  );
  rl.close();
}

runCli();
