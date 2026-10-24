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
 * Normalizes extracted numeric strings, properly handling thousands separators
 * (e.g. "1,200" -> "1200", "12,450.75" -> "12450.75", "450,50" -> "450.50").
 */
export function normalizeAmountString(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(trimmed)) {
    return trimmed.replace(/,/g, "");
  }
  if (/^\d+,\d{1,2}$/.test(trimmed)) {
    return trimmed.replace(",", ".");
  }
  return trimmed.replace(/,/g, "");
}

const NAME_STOPWORDS = new Set([
  "The",
  "Our",
  "My",
  "Your",
  "You",
  "Send",
  "Pay",
  "Invoice",
  "Please",
  "Total",
]);

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

    // 3. Amount / pricing extraction - support thousands commas (1,200 or 12,450.75) and multi-line items
    const numPattern = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
    const genericListLineRegex = /^\s*(?:\d+[.)]|[-*•])\s*(.+?)\s*$/gm;
    const exactPricedBodyRegex = new RegExp(
      `^(.+?)\\s*[:\\-–]\\s*(?:\\$|€|USD|EUR)?\\s*${numPattern}(?:\\s*(?:USD|EUR|\\$|€))?\\s*$`,
      "i"
    );
    const extractedItems: ExtractedInvoiceDraft["items"] = [];
    for (const listMatch of rawText.matchAll(genericListLineRegex)) {
      const fullLine = listMatch[0].trim();
      const body = listMatch[1].trim();
      const pricedMatch = body.match(exactPricedBodyRegex);
      if (pricedMatch) {
        const itemName = pricedMatch[1].trim();
        const itemPrice = normalizeAmountString(pricedMatch[2]);
        extractedItems.push({
          name: itemName || "Freelance Service Deliverable",
          quantity: "1",
          unit_amount: {
            currency_code: currencyVal ?? "USD",
            value: itemPrice,
          },
          sourceSpan: findExactSpan(rawText, fullLine),
          isAmbiguous: false,
          clarificationQuestion: null,
        });
      } else {
        // Unparsed or recurring list line (e.g. "$20/month" or "included") — never drop silently
        const parts = body.split(/\s*[:\-–]\s*/);
        const itemName = (parts[0] || body).trim() || "Deliverable";
        const candidateNum = body.match(new RegExp(numPattern));
        const fallbackPrice = candidateNum ? normalizeAmountString(candidateNum[1]) : "0.00";
        extractedItems.push({
          name: itemName,
          quantity: "1",
          unit_amount: {
            currency_code: currencyVal ?? "USD",
            value: fallbackPrice,
          },
          sourceSpan: findExactSpan(rawText, fullLine),
          isAmbiguous: true,
          clarificationQuestion: `Clarify pricing for "${fullLine}" — enter a one-time unit amount or remove the item.`,
        });
      }
    }

    let amountVal = "0.00";
    let amountMatch = rawText.match(new RegExp(`(?:\\$|€|USD|EUR)\\s*${numPattern}`, "i"));
    if (!amountMatch) {
      amountMatch = rawText.match(new RegExp(`\\b${numPattern}\\s*(?:USD|EUR|\\$|€)`, "i"));
    }
    if (!amountMatch) {
      amountMatch = rawText.match(new RegExp(`\\b${numPattern}\\b`));
    }
    if (amountMatch) {
      amountVal = normalizeAmountString(amountMatch[1]);
    }
    if (extractedItems.length === 0) {
      extractedItems.push({
        name: "Freelance Service Deliverable",
        quantity: "1",
        unit_amount: {
          currency_code: currencyVal ?? "USD",
          value: amountVal,
        },
        sourceSpan: amountMatch ? findExactSpan(rawText, amountMatch[0]) : null,
      });
    }

    // 4. Client name heuristic (strictly capitalized name tokens; never match lowercase words like "due to the delay")
    const nameMatch = rawText.match(
      /(?:^|\b)(?:[Hh]i|[Hh]ey|[Hh]ello|[Dd]ear|[Cc]lient:?|[Bb]ill\s+[Tt]o:?|[Tt]o)\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\b/
    );
    const candidateName = nameMatch ? nameMatch[1] : null;
    const firstWord = candidateName ? candidateName.split(/\s+/)[0] : "";
    const nameVal = candidateName && !NAME_STOPWORDS.has(firstWord) ? candidateName : null;
    const nameSpan = nameVal ? findExactSpan(rawText, nameVal) : null;

    // 5. Due date / payment term (never silently invent NET_14 when missing)
    let paymentTerm: ExtractedInvoiceDraft["paymentTerm"]["value"] = null;
    let termSpan: SourceSpan | null = null;
    let dueDateVal: string | null = null;
    let dueDateSpan: SourceSpan | null = null;
    let dateAmbiguous = false;
    let dateQuestion: string | null = null;

    const isoDateMatch = rawText.match(/\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/);
    const englishDateMatch = rawText.match(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i
    );
    if (isoDateMatch) {
      dueDateVal = isoDateMatch[1];
      dueDateSpan = findExactSpan(rawText, isoDateMatch[1]);
    } else if (englishDateMatch) {
      const monthMap: Record<string, string> = {
        jan: "01",
        feb: "02",
        mar: "03",
        apr: "04",
        may: "05",
        jun: "06",
        jul: "07",
        aug: "08",
        sep: "09",
        oct: "10",
        nov: "11",
        dec: "12",
      };
      const mKey = englishDateMatch[1].slice(0, 3).toLowerCase();
      const dayPadded = englishDateMatch[2].padStart(2, "0");
      dueDateVal = `${englishDateMatch[3]}-${monthMap[mKey]}-${dayPadded}`;
      dueDateSpan = findExactSpan(rawText, englishDateMatch[0]);
    }

    const termMatch = rawText.match(/net\s*(10|14|15|30|45|60)/i);
    const receiptMatch = rawText.match(/due\s+on\s+receipt/i);
    if (termMatch) {
      paymentTerm = `NET_${termMatch[1]}` as ExtractedInvoiceDraft["paymentTerm"]["value"];
      termSpan = findExactSpan(rawText, termMatch[0]);
    } else if (receiptMatch) {
      paymentTerm = "DUE_ON_RECEIPT";
      termSpan = findExactSpan(rawText, receiptMatch[0]);
    } else if (!dueDateVal) {
      dateAmbiguous = true;
      dateQuestion = "What is the payment term or due date for this invoice?";
    }

    const hasResolvedTermOrDate = Boolean(paymentTerm || dueDateVal);

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
        isAmbiguous: !hasResolvedTermOrDate,
        clarificationQuestion: hasResolvedTermOrDate
          ? null
          : "Specify payment term (e.g. NET_14, NET_30, DUE_ON_RECEIPT)?",
      },
      dueDate: {
        value: dueDateVal,
        sourceSpan: dueDateSpan,
        isAmbiguous: dateAmbiguous,
        clarificationQuestion: dateQuestion,
      },
      items: extractedItems,
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
