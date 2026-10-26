import { ExtractedInvoiceDraft, ReminderTone } from "./schema.js";

export interface ReminderDraftInput {
  draft: ExtractedInvoiceDraft;
  invoiceId: string;
  tone: ReminderTone;
}

export interface DraftedReminder {
  subject: string;
  note: string;
  tone: ReminderTone;
}

export interface ReminderDrafterProvider {
  draftReminder(input: ReminderDraftInput): Promise<DraftedReminder>;
}

function summarizeDraftContext(draft: ExtractedInvoiceDraft) {
  const clientName =
    draft.recipientName.value?.trim() ||
    draft.recipientEmail.value?.split("@")[0] ||
    "there";
  const currency = draft.currency.value || "USD";
  const totalNum = draft.items.reduce(
    (sum, item) => sum + (Number(item.quantity) || 1) * (Number(item.unit_amount.value) || 0),
    0
  );
  const totalFormatted = `${currency} ${totalNum.toFixed(2)}`;
  const deliverables = draft.items.map((it) => it.name).join(", ");
  const dueText = draft.dueDate.value
    ? `due on ${draft.dueDate.value}`
    : draft.paymentTerm.value
    ? `under ${draft.paymentTerm.value.replace("_", " ")} terms`
    : "per our agreement";

  return {
    clientName,
    currency,
    totalFormatted,
    deliverables,
    dueText,
  };
}

/**
 * Deterministic, zero-key reminder drafter used for offline/recorded evaluation
 * and as a reliable fallback when no LLM API key is configured.
 */
export class DeterministicReminderDrafter implements ReminderDrafterProvider {
  async draftReminder(input: ReminderDraftInput): Promise<DraftedReminder> {
    const { draft, invoiceId, tone } = input;
    const ctx = summarizeDraftContext(draft);

    if (tone === "gentle") {
      return {
        tone: "gentle",
        subject: `Friendly reminder: Invoice ${invoiceId} (${ctx.totalFormatted})`,
        note: `Hi ${ctx.clientName}, I hope everything is going well! Just a friendly check-in regarding PayPal Invoice ${invoiceId} for ${ctx.deliverables} (${ctx.totalFormatted}), ${ctx.dueText}. Please let me know if you have any questions or need anything else from my side.`,
      };
    }

    if (tone === "urgent") {
      return {
        tone: "urgent",
        subject: `Overdue payment notice: Invoice ${invoiceId} (${ctx.totalFormatted})`,
        note: `Hi ${ctx.clientName}, following up urgently on overdue PayPal Invoice ${invoiceId} for ${ctx.deliverables} (${ctx.totalFormatted}), ${ctx.dueText}. Please arrange payment via the PayPal invoice link at your earliest convenience or reply with an updated payment date.`,
      };
    }

    return {
      tone: "professional",
      subject: `Payment reminder: Invoice ${invoiceId} (${ctx.totalFormatted})`,
      note: `Hello ${ctx.clientName}, this is a polite reminder regarding PayPal Invoice ${invoiceId} for ${ctx.deliverables} totaling ${ctx.totalFormatted} (${ctx.dueText}). You can view and complete the payment directly through your PayPal invoice link. Thank you!`,
    };
  }
}

export interface OpenAiReminderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/**
 * LLM-powered reminder drafter using an OpenAI-compatible chat completions endpoint.
 * Falls back to DeterministicReminderDrafter if the model returns malformed output.
 */
export class OpenAiReminderDrafter implements ReminderDrafterProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fallback = new DeterministicReminderDrafter();

  constructor(private readonly cfg: OpenAiReminderConfig) {
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = cfg.model ?? "gpt-4o-mini";
  }

  async draftReminder(input: ReminderDraftInput): Promise<DraftedReminder> {
    const ctx = summarizeDraftContext(input.draft);
    const systemPrompt = [
      "You are an empathetic, financially responsible AI assistant helping an independent freelancer draft a payment reminder for an unpaid PayPal invoice.",
      "Return ONLY a valid JSON object with two string keys: \"subject\" and \"note\".",
      "Never invent fees, penalties, or figures that are not in the provided invoice context.",
    ].join(" ");

    const userPrompt = JSON.stringify({
      invoiceId: input.invoiceId,
      tone: input.tone,
      clientName: ctx.clientName,
      totalAmount: ctx.totalFormatted,
      deliverables: ctx.deliverables,
      paymentTermsOrDue: ctx.dueText,
    });

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        return this.fallback.draftReminder(input);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const rawContent = data.choices?.[0]?.message?.content?.trim();
      if (!rawContent) {
        return this.fallback.draftReminder(input);
      }

      const parsed = JSON.parse(rawContent) as { subject?: string; note?: string };
      if (
        typeof parsed.subject === "string" &&
        parsed.subject.trim().length > 0 &&
        typeof parsed.note === "string" &&
        parsed.note.trim().length > 0
      ) {
        return {
          subject: parsed.subject.trim(),
          note: parsed.note.trim(),
          tone: input.tone,
        };
      }
      return this.fallback.draftReminder(input);
    } catch {
      return this.fallback.draftReminder(input);
    }
  }
}
