import { z } from "zod";

// ISO 4217 Currency Code validation (e.g. USD, EUR, SGD)
export const CurrencyCodeSchema = z.string().length(3).regex(/^[A-Z]{3}$/, "Must be a 3-letter uppercase currency code");

export const SourceSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
});

export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export const ExtractedFieldSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    value: valueSchema.nullable(),
    sourceSpan: SourceSpanSchema.nullable(),
    isAmbiguous: z.boolean().default(false),
    clarificationQuestion: z.string().nullable().default(null),
  });

export const InvoiceItemSchema = z.object({
  name: z.string().min(1, "Item name cannot be empty"),
  description: z.string().optional(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/, "Quantity must be numeric string"),
  unit_amount: z.object({
    currency_code: CurrencyCodeSchema,
    value: z.string().regex(/^\d+(\.\d{1,2})?$/, "Unit amount must be numeric with up to 2 decimal places"),
  }),
  sourceSpan: SourceSpanSchema.nullable().optional(),
});

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

// Full structured draft format aligning with PayPal Invoicing v2 schema specs
export const ExtractedInvoiceDraftSchema = z.object({
  recipientEmail: ExtractedFieldSchema(z.string().email()),
  recipientName: ExtractedFieldSchema(z.string()),
  currency: ExtractedFieldSchema(CurrencyCodeSchema),
  paymentTerm: ExtractedFieldSchema(z.enum(["DUE_ON_RECEIPT", "NET_10", "NET_14", "NET_15", "NET_30", "NET_45", "NET_60"])),
  dueDate: ExtractedFieldSchema(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")),
  items: z.array(InvoiceItemSchema).min(1, "Invoice must contain at least 1 item"),
  note: ExtractedFieldSchema(z.string()).optional(),
});

export type ExtractedInvoiceDraft = z.infer<typeof ExtractedInvoiceDraftSchema>;

/**
 * Transforms an ExtractedInvoiceDraft into the exact payload required by
 * PayPal Invoicing v2: POST /v2/invoicing/invoices
 */
export function formatPayPalInvoiceV2Payload(draft: ExtractedInvoiceDraft, invoicerEmail?: string) {
  if (!draft.recipientEmail.value) {
    throw new Error("Cannot build PayPal invoice payload without valid recipient email.");
  }
  if (!draft.currency.value) {
    throw new Error("Cannot build PayPal invoice payload without specified currency.");
  }

  const payload: Record<string, unknown> = {
    detail: {
      currency_code: draft.currency.value,
      note: draft.note?.value ?? "Generated via Freelance Invoice Copilot",
      payment_term: {
        term_type: draft.paymentTerm.value ?? "NET_14",
        ...(draft.dueDate.value ? { due_date: draft.dueDate.value } : {}),
      },
    },
    primary_recipients: [
      {
        billing_info: {
          email_address: draft.recipientEmail.value,
          ...(draft.recipientName.value
            ? {
                name: {
                  full_name: draft.recipientName.value,
                },
              }
            : {}),
        },
      },
    ],
    items: draft.items.map((item) => ({
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unit_amount: {
        currency_code: item.unit_amount.currency_code,
        value: item.unit_amount.value,
      },
    })),
  };

  if (invoicerEmail) {
    payload.invoicer = {
      email_address: invoicerEmail,
    };
  }

  return payload;
}
