import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiExtractionProvider } from "../src/aiExtractor.js";

describe("OpenAiExtractionProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("extracts structured fields and maps exactQuotes to character offsets in rawText", async () => {
    const rawText =
      "Hi Liam, the mobile UX audit is done for €850. Send invoice to liam@nordic.test under Net 15.";

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                recipientEmail: "liam@nordic.test",
                recipientName: "Liam",
                currency: "EUR",
                paymentTerm: "NET_15",
                dueDate: null,
                items: [
                  {
                    name: "mobile UX audit",
                    quantity: "1",
                    unitPrice: "850.00",
                  },
                ],
                note: "Thank you for the collaboration.",
                exactQuotes: {
                  recipientEmail: "liam@nordic.test",
                  recipientName: "Liam",
                  currency: "€",
                  paymentTerm: "Net 15",
                },
                questions: [],
              }),
            },
          },
        ],
      }),
    });
    global.fetch = mockFetch;

    const provider = new OpenAiExtractionProvider({
      apiKey: "test-key",
      baseURL: "https://api.example.com/v1",
      model: "test-model",
    });

    const draft = await provider.extractInvoice(rawText);

    expect(draft.recipientEmail.value).toBe("liam@nordic.test");
    expect(draft.recipientEmail.sourceSpan?.text).toBe("liam@nordic.test");
    expect(draft.recipientName.value).toBe("Liam");
    expect(draft.currency.value).toBe("EUR");
    expect(draft.currency.sourceSpan?.text).toBe("€");
    expect(draft.paymentTerm.value).toBe("NET_15");
    expect(draft.paymentTerm.sourceSpan?.text).toBe("Net 15");
    expect(draft.items[0].name).toBe("mobile UX audit");
    expect(draft.items[0].sourceSpan?.text).toBe("mobile UX audit");
    expect(draft.items[0].unit_amount.value).toBe("850.00");
  });

  it("flags missing critical fields (including paymentTerm) as null and ambiguous without guessing", async () => {
    const rawText = "Finished the backend API refactoring, total is 600.";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                recipientEmail: null,
                recipientName: null,
                currency: null,
                paymentTerm: null,
                dueDate: null,
                items: [{ name: "backend API refactoring", quantity: "1", unitPrice: "600.00" }],
                exactQuotes: {},
              }),
            },
          },
        ],
      }),
    });

    const provider = new OpenAiExtractionProvider({ apiKey: "test-key" });
    const draft = await provider.extractInvoice(rawText);

    expect(draft.recipientEmail.value).toBeNull();
    expect(draft.recipientEmail.isAmbiguous).toBe(true);
    expect(draft.recipientEmail.clarificationQuestion).toBeTruthy();

    expect(draft.currency.value).toBeNull();
    expect(draft.currency.isAmbiguous).toBe(true);
    expect(draft.currency.clarificationQuestion).toBeTruthy();

    expect(draft.paymentTerm.value).toBeNull();
    expect(draft.paymentTerm.isAmbiguous).toBe(true);
    expect(draft.paymentTerm.clarificationQuestion).toBeTruthy();
  });

  it("throws a descriptive error when LLM returns non-JSON content", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Not valid JSON response" } }],
      }),
    });

    const provider = new OpenAiExtractionProvider({ apiKey: "test-key" });
    await expect(provider.extractInvoice("Hello")).rejects.toThrow(
      /Failed to parse LLM extraction JSON/i
    );
  });

  it("throws a clear error when the LLM endpoint returns non-OK HTTP status", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized API key",
    });

    const provider = new OpenAiExtractionProvider({ apiKey: "invalid-key" });
    await expect(provider.extractInvoice("Hello")).rejects.toThrow(/HTTP 401/);
  });
});
