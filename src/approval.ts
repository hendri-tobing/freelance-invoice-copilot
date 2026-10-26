// Two-step approval gate. Pure logic, no network calls, so it is unit-testable.
// Step 1: the freelancer approves creating a DRAFT in PayPal.
// Step 2: the freelancer separately approves SENDING that draft to the client.
// Sending is never implied by draft creation.

export type Stage = "proposed" | "draft_created" | "sent";

export interface InvoiceFlow {
  stage: Stage;
  draftApprovedAt?: string;
  sentApprovedAt?: string;
  paypalInvoiceId?: string;
}

export const newFlow = (): InvoiceFlow => ({ stage: "proposed" });

export function approveDraft(flow: InvoiceFlow, now: Date = new Date()): InvoiceFlow {
  if (flow.stage !== "proposed") throw new Error(`Cannot create draft from stage "${flow.stage}".`);
  return { ...flow, draftApprovedAt: now.toISOString() };
}

export function recordDraftCreated(flow: InvoiceFlow, paypalInvoiceId: string): InvoiceFlow {
  if (!flow.draftApprovedAt) throw new Error("Draft creation was not approved.");
  return { ...flow, stage: "draft_created", paypalInvoiceId };
}

export function approveSend(flow: InvoiceFlow, now: Date = new Date()): InvoiceFlow {
  if (flow.stage !== "draft_created" || !flow.paypalInvoiceId) {
    throw new Error(`Cannot send from stage "${flow.stage}". A draft must exist first.`);
  }
  return { ...flow, sentApprovedAt: now.toISOString() };
}

export function recordSent(flow: InvoiceFlow): InvoiceFlow {
  if (!flow.sentApprovedAt) throw new Error("Sending was not approved.");
  return { ...flow, stage: "sent" };
}

export type ReminderTone = "gentle" | "professional" | "urgent";

export interface ReminderRecord {
  id?: string;
  sentAt: string;
  subject: string;
  note: string;
  tone: ReminderTone;
}

export function canSendReminder(
  flow: InvoiceFlow,
  reminderHistory: ReminderRecord[] = [],
  now: Date = new Date()
): { allowed: boolean; reason?: string } {
  if (flow.stage !== "sent" || !flow.paypalInvoiceId) {
    return {
      allowed: false,
      reason: `Cannot send reminder from stage "${flow.stage}". Invoice must be in "sent" stage first.`,
    };
  }

  const todayPrefix = now.toISOString().slice(0, 10);
  const sentToday = reminderHistory.filter((r) => r.sentAt.slice(0, 10) === todayPrefix).length;
  if (sentToday >= 2) {
    return {
      allowed: false,
      reason: "PayPal enforces a maximum of 2 reminders per day per invoice.",
    };
  }

  return { allowed: true };
}
