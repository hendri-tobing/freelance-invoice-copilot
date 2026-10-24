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

  it("extracts details and sets missing paymentTerm to null (never silently guessing NET_14)", async () => {
    const rawText = `Hi Alex, here is the recap:
1. Landing page design: $500
Please send invoice to alex@company.test`;

    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(rawText);

    expect(draft.recipientName.value).toBe("Alex");
    expect(draft.recipientEmail.value).toBe("alex@company.test");
    expect(draft.currency.value).toBe("USD");
    expect(draft.items[0].unit_amount.value).toBe("500");

    // Payment term / due date was not in text: value must be null, never silently defaulted to NET_14
    expect(draft.paymentTerm.value).toBeNull();
    expect(draft.paymentTerm.isAmbiguous).toBe(true);
    expect(draft.paymentTerm.clarificationQuestion).toBeTruthy();
    expect(draft.dueDate.value).toBeNull();
    expect(draft.dueDate.isAmbiguous).toBe(true);

    // Payload formatter must reject draft when neither paymentTerm nor dueDate is resolved
    expect(() => formatPayPalInvoiceV2Payload(draft)).toThrow(/payment term or due date/i);
  });

  it("parses thousands separators accurately ($1,200 -> 1200 and $12,450.75 -> 12450.75)", async () => {
    const extractor = new DeterministicExtractor();

    const draft1 = await extractor.extractInvoice(
      "Hi Sarah, total is $1,200 USD net 30 to sarah@client.org."
    );
    expect(draft1.items[0].unit_amount.value).toBe("1200");
    expect(draft1.items[0].sourceSpan?.text).toBe("$1,200");

    const draft2 = await extractor.extractInvoice(
      "Hi Sarah, total is 12,450.75 EUR net 15 to sarah@client.org."
    );
    expect(draft2.items[0].unit_amount.value).toBe("12450.75");
  });

  it("does not match lowercase words like 'due to the delay' as recipientName", async () => {
    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(
      "Apologies due to the delay on the sprint. Total is $300 USD net 14 for billing@client.test."
    );
    expect(draft.recipientName.value).toBeNull();
  });

  it("formats compliant PayPal Invoicing v2 payload structure", async () => {
    const rawText = "To Sarah, payment is $1,200 net 30 via sarah@client.org for UI audit.";
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

  it("extracts multiple line items from numbered or bulleted agreements", async () => {
    const rawText = `Hi Alex, here is the project wrap-up:
1. Landing page design & Framer handoff: $650 USD
2. Interactive prototype & icon set: $250 USD
Please send the invoice to alex@brightlabs.test under Net 14.`;

    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(rawText);

    expect(draft.items).toHaveLength(2);
    expect(draft.items[0].name).toBe("Landing page design & Framer handoff");
    expect(draft.items[0].unit_amount.value).toBe("650");
    expect(draft.items[0].sourceSpan?.text).toContain("Landing page design");
    expect(draft.items[1].name).toBe("Interactive prototype & icon set");
    expect(draft.items[1].unit_amount.value).toBe("250");
  });

  it("flags unparsed or recurring list lines as ambiguous items instead of silently dropping them", async () => {
    const rawText = `Hi Alex, here is the breakdown:
1. Landing page design: $500 USD
2. Managed hosting: $20/month
3. Two rounds of revisions: included
Send invoice to alex@brightlabs.test Net 14.`;

    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(rawText);

    // Must not silently drop lines 2 and 3
    expect(draft.items).toHaveLength(3);
    expect(draft.items[0].isAmbiguous).toBeFalsy();
    expect(draft.items[0].unit_amount.value).toBe("500");

    expect(draft.items[1].name).toContain("Managed hosting");
    expect(draft.items[1].isAmbiguous).toBe(true);
    expect(draft.items[1].clarificationQuestion).toMatch(/hosting/i);

    expect(draft.items[2].name).toContain("Two rounds of revisions");
    expect(draft.items[2].isAmbiguous).toBe(true);
    expect(draft.items[2].clarificationQuestion).toMatch(/revisions/i);

    // Formatting PayPal payload must fail while ambiguous items remain unresolved
    expect(() => formatPayPalInvoiceV2Payload(draft)).toThrow(/clarification|greater than 0/i);
  });
});
