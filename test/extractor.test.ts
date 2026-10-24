import { describe, it, expect } from "vitest";
import {
  DeterministicExtractor,
  findExactSpan,
} from "../src/extractor.js";
import { formatPayPalInvoiceV2Payload } from "../src/schema.js";

describe("DeterministicExtractor & Provenance Spans", () => {
  it("locates exact text span with accurate offsets", () => {
    const raw = "Total agreement is $450 for the website rework.";
    const span = findExactSpan(raw, "$450");
    expect(span).not.toBeNull();
    expect(span?.start).toBe(19);
    expect(span?.end).toBe(23);
    expect(raw.slice(span!.start, span!.end)).toBe("$450");
  });

  it("extracts details and correctly flags missing/ambiguous items as questions", async () => {
    const rawText = `Hi Alex, here is the recap:
1. Landing page design: $500
Please send invoice to alex@company.test`;

    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(rawText);

    expect(draft.recipientName.value).toBe("Alex");
    expect(draft.recipientEmail.value).toBe("alex@company.test");
    expect(draft.currency.value).toBe("USD");
    expect(draft.items[0].unit_amount.value).toBe("500");

    // Payment term / due date was not in text, so it must be flagged as ambiguous with a clarification question
    expect(draft.paymentTerm.isAmbiguous).toBe(true);
    expect(draft.dueDate.isAmbiguous).toBe(true);
    expect(draft.dueDate.clarificationQuestion).toBeTruthy();
  });

  it("formats compliant PayPal Invoicing v2 payload structure", async () => {
    const rawText = "To Sarah, payment is $1200 net 30 via sarah@client.org for UI audit.";
    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(rawText);

    const payload = formatPayPalInvoiceV2Payload(draft, "me@freelancer.dev");

    expect(payload).toHaveProperty("detail");
    expect((payload.detail as any).currency_code).toBe("USD");
    expect((payload.detail as any).payment_term.term_type).toBe("NET_30");
    expect(payload).toHaveProperty("primary_recipients");
    expect((payload.primary_recipients as any)[0].billing_info.email_address).toBe("sarah@client.org");
    expect((payload.invoicer as any).email_address).toBe("me@freelancer.dev");
    expect(payload).toHaveProperty("items");
    expect((payload.items as any)[0].unit_amount.value).toBe("1200");
  });
});
