import { describe, it, expect } from "vitest";
import { newFlow, approveDraft, recordDraftCreated, approveSend, recordSent } from "../src/approval.js";

describe("two-step approval gate", () => {
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
});
