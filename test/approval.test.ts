import { describe, it, expect } from "vitest";
import {
  newFlow,
  approveDraft,
  recordDraftCreated,
  approveSend,
  recordSent,
  canSendReminder,
  ReminderRecord,
} from "../src/approval.js";

describe("two-step approval gate & Gate 3 reminder eligibility", () => {
  it("happy path: approve draft -> create -> approve send -> sent", () => {
    let f = newFlow();
    f = approveDraft(f);
    f = recordDraftCreated(f, "INV-1");
    expect(f.stage).toBe("draft_created");
    f = approveSend(f);
    f = recordSent(f);
    expect(f.stage).toBe("sent");
    expect(f.paypalInvoiceId).toBe("INV-1");
  });

  it("cannot create a draft without approval", () => {
    expect(() => recordDraftCreated(newFlow(), "INV-1")).toThrow(/not approved/);
  });

  it("cannot approve sending before a draft exists", () => {
    expect(() => approveSend(newFlow())).toThrow(/must exist first/);
    const approvedOnly = approveDraft(newFlow());
    expect(() => approveSend(approvedOnly)).toThrow(/must exist first/);
  });

  it("draft approval does not imply send approval", () => {
    const f = recordDraftCreated(approveDraft(newFlow()), "INV-1");
    expect(f.sentApprovedAt).toBeUndefined();
    expect(() => recordSent(f)).toThrow(/not approved/);
  });

  it("cannot approve a draft twice from a later stage", () => {
    const f = recordDraftCreated(approveDraft(newFlow()), "INV-1");
    expect(() => approveDraft(f)).toThrow(/Cannot create draft/);
  });

  it("Gate 3: disallows reminder when stage is proposed or draft_created", () => {
    const proposed = newFlow();
    expect(canSendReminder(proposed, []).allowed).toBe(false);
    expect(canSendReminder(proposed, []).reason).toMatch(/sent/i);

    const draftCreated = recordDraftCreated(approveDraft(newFlow()), "INV-1");
    expect(canSendReminder(draftCreated, []).allowed).toBe(false);
    expect(canSendReminder(draftCreated, []).reason).toMatch(/sent/i);
  });

  it("Gate 3: allows reminder when stage is sent and enforces max 2 reminders per day", () => {
    const sentFlow = recordSent(approveSend(recordDraftCreated(approveDraft(newFlow()), "INV-1")));
    const now = new Date("2026-10-26T10:00:00.000Z");

    expect(canSendReminder(sentFlow, [], now)).toEqual({ allowed: true });

    const r1: ReminderRecord = {
      sentAt: "2026-10-26T08:00:00.000Z",
      subject: "Reminder 1",
      note: "Follow up 1",
      tone: "gentle",
    };
    expect(canSendReminder(sentFlow, [r1], now)).toEqual({ allowed: true });

    const r2: ReminderRecord = {
      sentAt: "2026-10-26T09:30:00.000Z",
      subject: "Reminder 2",
      note: "Follow up 2",
      tone: "professional",
    };
    const thirdAttempt = canSendReminder(sentFlow, [r1, r2], now);
    expect(thirdAttempt.allowed).toBe(false);
    expect(thirdAttempt.reason).toMatch(/maximum of 2 reminders per day/i);

    // Next day allows sending again
    const nextDay = new Date("2026-10-27T10:00:00.000Z");
    expect(canSendReminder(sentFlow, [r1, r2], nextDay)).toEqual({ allowed: true });
  });
});
