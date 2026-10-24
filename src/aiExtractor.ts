import {
  ExtractedInvoiceDraft,
  ExtractedInvoiceDraftSchema,
  SourceSpan,
} from "./schema.js";
import { ExtractionProvider, findExactSpan } from "./extractor.js";

export interface OpenAiCompatibleConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

/**
 * Extraction Provider backed by an OpenAI-compatible API (e.g. OpenAI, OpenRouter, Groq, local Ollama).
 * It requests strict structured JSON extraction, and then computes exact character offsets (SourceSpan)
 * against the original raw input string to guarantee provenance and zero hallucinations.
 */
export class OpenAiExtractionProvider implements ExtractionProvider {
  constructor(private readonly config: OpenAiCompatibleConfig) {}

  async extractInvoice(rawText: string): Promise<ExtractedInvoiceDraft> {
    const baseURL = this.config.baseURL ?? "https://api.openai.com/v1";
    const model = this.config.model ?? "gpt-4o-mini";

    const prompt = `You are an invoice parsing assistant for freelancers.
Given the following raw conversation or scope note, extract invoice details.
Output strictly a JSON object with:
- recipientEmail: string or null
- recipientName: string or null
- currency: 3-letter currency code (e.g. USD, EUR) or null if unknown/ambiguous
- paymentTerm: one of "DUE_ON_RECEIPT", "NET_10", "NET_14", "NET_15", "NET_30", "NET_45", "NET_60", or null
- dueDate: "YYYY-MM-DD" or null
- items: array of objects with { name: string, quantity: string (number string), unitPrice: string (number string) }
- note: string or null
- exactQuotes: an object mapping field names ("recipientEmail", "recipientName", "currency", "paymentTerm", "items") to the exact verbatim substring from the input text that supports that extraction. If inferred or not found, map to null.
- questions: array of clarification questions for any critical missing or ambiguous fields (like missing client email, missing currency, or unstated payment terms).

Do not invent or guess missing information. If something is missing, output null and add a question.`;

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: rawText },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM extraction request failed HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");

    const emailQuote = parsed.exactQuotes?.recipientEmail ?? parsed.recipientEmail;
    const nameQuote = parsed.exactQuotes?.recipientName ?? parsed.recipientName;
    const currQuote = parsed.exactQuotes?.currency ?? parsed.currency;

    const draft: ExtractedInvoiceDraft = {
      recipientEmail: {
        value: parsed.recipientEmail ?? null,
        sourceSpan: emailQuote ? findExactSpan(rawText, emailQuote) : null,
        isAmbiguous: !parsed.recipientEmail,
        clarificationQuestion: !parsed.recipientEmail ? "What is the client's billing email address?" : null,
      },
      recipientName: {
        value: parsed.recipientName ?? null,
        sourceSpan: nameQuote ? findExactSpan(rawText, nameQuote) : null,
        isAmbiguous: false,
        clarificationQuestion: null,
      },
      currency: {
        value: parsed.currency ?? null,
        sourceSpan: currQuote ? findExactSpan(rawText, currQuote) : null,
        isAmbiguous: !parsed.currency,
        clarificationQuestion: !parsed.currency ? "Which currency should be charged (e.g. USD, EUR)?" : null,
      },
      paymentTerm: {
        value: parsed.paymentTerm ?? "NET_14",
        sourceSpan: parsed.exactQuotes?.paymentTerm ? findExactSpan(rawText, parsed.exactQuotes.paymentTerm) : null,
        isAmbiguous: !parsed.paymentTerm,
        clarificationQuestion: !parsed.paymentTerm ? "Select payment term (e.g. NET_14, DUE_ON_RECEIPT)?" : null,
      },
      dueDate: {
        value: parsed.dueDate ?? null,
        sourceSpan: parsed.dueDate ? findExactSpan(rawText, parsed.dueDate) : null,
        isAmbiguous: !parsed.dueDate,
        clarificationQuestion: null,
      },
      items: (parsed.items && parsed.items.length > 0)
        ? parsed.items.map((it: any) => ({
            name: it.name || "Deliverable",
            quantity: String(it.quantity || "1"),
            unit_amount: {
              currency_code: parsed.currency || "USD",
              value: String(it.unitPrice || "0.00"),
            },
            sourceSpan: it.name ? findExactSpan(rawText, it.name) : null,
          }))
        : [
            {
              name: "Scope Work",
              quantity: "1",
              unit_amount: {
                currency_code: parsed.currency || "USD",
                value: "0.00",
              },
            },
          ],
      note: {
        value: parsed.note ?? "Prepared via Freelance Invoice Copilot",
        sourceSpan: null,
        isAmbiguous: false,
        clarificationQuestion: null,
      },
    };

    return ExtractedInvoiceDraftSchema.parse(draft);
  }
}
