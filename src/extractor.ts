import {
  ExtractedInvoiceDraft,
  ExtractedInvoiceDraftSchema,
  SourceSpan,
} from "./schema.js";

export interface ExtractionProvider {
  extractInvoice(rawText: string): Promise<ExtractedInvoiceDraft>;
}

/**
 * Finds exact span [start, end] and substring of target in the rawText.
 * Avoids LLM-hallucinated quotes.
 */
export function findExactSpan(rawText: string, target: string): SourceSpan | null {
  if (!target) return null;
  const index = rawText.indexOf(target);
  if (index === -1) return null;
  return {
    start: index,
    end: index + target.length,
    text: rawText.slice(index, index + target.length),
  };
}

/**
 * Rule-based heuristic extractor used as an offline fallback,
 * baseline comparator, and test mock for judges when no live LLM key is supplied.
 */
export class DeterministicExtractor implements ExtractionProvider {
  async extractInvoice(rawText: string): Promise<ExtractedInvoiceDraft> {
    // 1. Email extraction
    const emailMatch = rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const emailVal = emailMatch ? emailMatch[0] : null;
    const emailSpan = emailVal ? findExactSpan(rawText, emailVal) : null;

    // 2. Currency extraction
    let currencyVal: string | null = null;
    let currencySpan: SourceSpan | null = null;
    let currencyAmbiguous = false;
    let currencyQuestion: string | null = null;

    if (/\$|USD/i.test(rawText)) {
      currencyVal = "USD";
      const match = rawText.match(/\$|USD/i);
      if (match) currencySpan = findExactSpan(rawText, match[0]);
    } else if (/€|EUR/i.test(rawText)) {
      currencyVal = "EUR";
      const match = rawText.match(/€|EUR/i);
      if (match) currencySpan = findExactSpan(rawText, match[0]);
    } else {
      currencyAmbiguous = true;
      currencyQuestion = "Which currency should be used for this invoice (e.g., USD, EUR, SGD)?";
    }

    // 3. Amount / pricing extraction - prioritize currency-prefixed or explicit number
    let amountVal = "0.00";
    let amountMatch = rawText.match(/(?:\$|€|USD|EUR)\s*(\d+(?:[.,]\d{2})?)/i);
    if (!amountMatch) {
      amountMatch = rawText.match(/\b(\d+(?:[.,]\d{2})?)\s*(?:USD|EUR|\$|€)/i);
    }
    if (!amountMatch) {
      amountMatch = rawText.match(/\b(\d+(?:\.\d{2})?)\b/);
    }
    if (amountMatch) {
      amountVal = amountMatch[1].replace(",", ".");
    }

    // 4. Client name heuristic (e.g., "Hi Alex", "to Alex", "client: Alex")
    const nameMatch = rawText.match(/(?:to|client|hi|hey)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    const nameVal = nameMatch ? nameMatch[1] : null;
    const nameSpan = nameVal ? findExactSpan(rawText, nameVal) : null;

    // 5. Due date / payment term
    let paymentTerm: "DUE_ON_RECEIPT" | "NET_10" | "NET_14" | "NET_15" | "NET_30" = "NET_14";
    let termSpan: SourceSpan | null = null;
    let dueDateVal: string | null = null;
    let dueDateSpan: SourceSpan | null = null;
    let dateAmbiguous = false;
    let dateQuestion: string | null = null;

    const termMatch = rawText.match(/net\s*(10|14|15|30)/i);
    if (termMatch) {
      paymentTerm = `NET_${termMatch[1]}` as any;
      termSpan = findExactSpan(rawText, termMatch[0]);
    } else {
      dateAmbiguous = true;
      dateQuestion = "What is the payment term or due date for this invoice?";
    }

    const draftData: ExtractedInvoiceDraft = {
      recipientEmail: {
        value: emailVal,
        sourceSpan: emailSpan,
        isAmbiguous: !emailVal,
        clarificationQuestion: emailVal ? null : "What is the client's email address for PayPal billing?",
      },
      recipientName: {
        value: nameVal,
        sourceSpan: nameSpan,
        isAmbiguous: false,
        clarificationQuestion: null,
      },
      currency: {
        value: currencyVal,
        sourceSpan: currencySpan,
        isAmbiguous: currencyAmbiguous,
        clarificationQuestion: currencyQuestion,
      },
      paymentTerm: {
        value: paymentTerm,
        sourceSpan: termSpan,
        isAmbiguous: !termSpan,
        clarificationQuestion: termSpan ? null : "Specify payment term (e.g. NET_14, DUE_ON_RECEIPT)?",
      },
      dueDate: {
        value: dueDateVal,
        sourceSpan: dueDateSpan,
        isAmbiguous: dateAmbiguous,
        clarificationQuestion: dateQuestion,
      },
      items: [
        {
          name: "Freelance Service Deliverable",
          quantity: "1",
          unit_amount: {
            currency_code: currencyVal ?? "USD",
            value: amountVal,
          },
          sourceSpan: amountMatch ? findExactSpan(rawText, amountMatch[0]) : null,
        },
      ],
      note: {
        value: "Payment request based on agreed scope.",
        sourceSpan: null,
        isAmbiguous: false,
        clarificationQuestion: null,
      },
    };

    return ExtractedInvoiceDraftSchema.parse(draftData);
  }
}
