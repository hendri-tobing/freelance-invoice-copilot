import { randomUUID } from "node:crypto";
import {
  InvoiceFlow,
  newFlow,
  approveDraft,
  recordDraftCreated,
  approveSend,
  recordSent,
} from "./approval.js";
import {
  ExtractedInvoiceDraft,
  ExtractedInvoiceDraftSchema,
  formatPayPalInvoiceV2Payload,
  InvoiceItem,
} from "./schema.js";
import { DeterministicExtractor, ExtractionProvider } from "./extractor.js";
import { OpenAiExtractionProvider } from "./aiExtractor.js";
import { loadConfig, PayPalClient } from "./paypal.js";

export type ExtractionMode = "live_ai" | "deterministic";
export type PayPalMode = "live_sandbox" | "recorded_sandbox";

export interface PayPalInvoiceRecord {
  id: string;
  status: string;
  recipientViewUrl?: string;
  invoicerViewUrl?: string;
  simulationMode: boolean;
  rawResponse: Record<string, unknown>;
}

export interface PayPalGateway {
  createDraftInvoice(
    invoice: unknown,
    requestId: string
  ): Promise<{ id: string; status?: string; [key: string]: unknown }>;
  getInvoice(
    invoiceId: string
  ): Promise<{
    id: string;
    status: string;
    detail?: Record<string, unknown>;
    links?: Array<{ href: string; rel: string }>;
    [key: string]: unknown;
  }>;
  sendInvoice(invoiceId: string, sendBody?: unknown): Promise<unknown>;
  simulateBuyerPayment?(invoiceId: string): Promise<void>;
}

/**
 * Clearly labeled Recorded / Local Sandbox Simulation Gateway for judges and local runs
 * when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set in the environment.
 */
export class RecordedPayPalGateway implements PayPalGateway {
  private readonly store = new Map<
    string,
    {
      id: string;
      status: string;
      payload: unknown;
      createdAt: string;
      updatedAt: string;
    }
  >();

  async createDraftInvoice(invoice: unknown, _requestId: string) {
    const shortId = randomUUID().slice(0, 8).toUpperCase();
    const id = `INV2-SIM-${shortId}`;
    const now = new Date().toISOString();
    this.store.set(id, {
      id,
      status: "DRAFT",
      payload: invoice,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id,
      status: "DRAFT",
      simulation_notice: "RECORDED_SANDBOX_SIMULATION",
      detail: {
        metadata: {
          create_time: now,
          invoicer_view_url: `https://www.sandbox.paypal.com/invoice/details/${id}`,
        },
      },
    };
  }

  async getInvoice(invoiceId: string) {
    const rec = this.store.get(invoiceId);
    if (!rec) {
      throw new Error(`Recorded sandbox invoice not found: ${invoiceId}`);
    }
    return {
      id: rec.id,
      status: rec.status,
      simulation_notice: "RECORDED_SANDBOX_SIMULATION",
      detail: {
        ...(typeof rec.payload === "object" && rec.payload !== null
          ? (rec.payload as Record<string, unknown>).detail ?? {}
          : {}),
        metadata: {
          create_time: rec.createdAt,
          last_update_time: rec.updatedAt,
          recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${rec.id}`,
          invoicer_view_url: `https://www.sandbox.paypal.com/invoice/details/${rec.id}`,
        },
      },
      links: [
        {
          rel: "self",
          href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${rec.id}`,
        },
      ],
    };
  }

  async sendInvoice(invoiceId: string) {
    const rec = this.store.get(invoiceId);
    if (!rec) {
      throw new Error(`Recorded sandbox invoice not found: ${invoiceId}`);
    }
    rec.status = "SENT";
    rec.updatedAt = new Date().toISOString();
    return {
      href: `https://www.sandbox.paypal.com/invoice/p/#${rec.id}`,
      rel: "payer-view",
      simulation_notice: "RECORDED_SANDBOX_SIMULATION",
    };
  }

  async simulateBuyerPayment(invoiceId: string) {
    const rec = this.store.get(invoiceId);
    if (!rec) {
      throw new Error(`Recorded sandbox invoice not found: ${invoiceId}`);
    }
    if (rec.status !== "SENT") {
      throw new Error(`Cannot pay an invoice in status "${rec.status}". Must be SENT first.`);
    }
    rec.status = "PAID";
    rec.updatedAt = new Date().toISOString();
  }
}

export interface UnresolvedQuestion {
  field: string;
  question: string;
  required: boolean;
}

export interface InvoiceSession {
  id: string;
  rawText: string;
  draft: ExtractedInvoiceDraft;
  flow: InvoiceFlow;
  unresolvedQuestions: UnresolvedQuestion[];
  formattedPayPalPayload: Record<string, unknown> | null;
  paypalInvoice: PayPalInvoiceRecord | null;
  extractionMode: ExtractionMode;
  paypalMode: PayPalMode;
  createdAt: string;
  updatedAt: string;
}

export interface DraftUpdatePatch {
  recipientEmail?: string;
  recipientName?: string;
  currency?: string;
  paymentTerm?: "DUE_ON_RECEIPT" | "NET_10" | "NET_14" | "NET_15" | "NET_30" | "NET_45" | "NET_60";
  dueDate?: string | null;
  note?: string;
  items?: Array<{
    name: string;
    description?: string;
    quantity: string;
    unitPrice: string;
  }>;
}

export interface SampleScenario {
  id: string;
  title: string;
  badge: string;
  description: string;
  rawText: string;
}

export const SAMPLE_SCENARIOS: SampleScenario[] = [
  {
    id: "ambiguous-currency-and-term",
    title: "Scenario 1: Ambiguous Currency & Missing Term (Recommended Demo)",
    badge: "Flags 2 Questions",
    description:
      "Client message agrees on 450 for a dashboard redesign and gives an email, but omits the currency and payment term.",
    rawText: `Hey Maya!
Finished the responsive dashboard redesign for your web app.
Total as agreed is 450 for the milestone.
Please let me know if I should send the invoice to maya@techstudio.test when ready!`,
  },
  {
    id: "missing-due-date",
    title: "Scenario 2: Explicit USD, Missing Payment Term",
    badge: "Flags 1 Question",
    description:
      "Clear USD amount and client email, but no due date or Net payment term stated in the chat.",
    rawText: `Hi Alex, here is the project wrap-up:
1. Landing page design & Framer handoff: $650 USD
I will prepare the invoice for alex@brightlabs.test.`,
  },
  {
    id: "complete-agreement",
    title: "Scenario 3: Complete Agreement (Ready for Gate 1)",
    badge: "All Fields Present",
    description:
      "Contains client name, email, USD currency, $1200 amount, and Net 30 payment terms.",
    rawText: `Hi Sarah, wrapping up the mobile checkout UI audit as agreed for $1200 USD.
Sending the billing details to sarah@fintech-client.test under Net 30 terms.`,
  },
];

export interface WorkflowServiceOptions {
  extractor: ExtractionProvider;
  paypal: PayPalGateway;
  extractionMode: ExtractionMode;
  paypalMode: PayPalMode;
  invoicerEmail?: string;
}

export function createWorkflowServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env
): InvoiceWorkflowService {
  let extractor: ExtractionProvider;
  let extractionMode: ExtractionMode;

  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0) {
    extractor = new OpenAiExtractionProvider({
      apiKey: env.OPENAI_API_KEY.trim(),
      baseURL: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL,
    });
    extractionMode = "live_ai";
  } else {
    extractor = new DeterministicExtractor();
    extractionMode = "deterministic";
  }

  let paypal: PayPalGateway;
  let paypalMode: PayPalMode;

  if (
    env.PAYPAL_CLIENT_ID &&
    env.PAYPAL_CLIENT_ID.trim().length > 0 &&
    env.PAYPAL_CLIENT_SECRET &&
    env.PAYPAL_CLIENT_SECRET.trim().length > 0
  ) {
    paypal = new PayPalClient(loadConfig(env));
    paypalMode = "live_sandbox";
  } else {
    paypal = new RecordedPayPalGateway();
    paypalMode = "recorded_sandbox";
  }

  return new InvoiceWorkflowService({
    extractor,
    paypal,
    extractionMode,
    paypalMode,
    invoicerEmail: env.PAYPAL_INVOICER_EMAIL,
  });
}

export class InvoiceWorkflowService {
  private readonly sessions = new Map<string, InvoiceSession>();

  constructor(private readonly opts: WorkflowServiceOptions) {}

  public getModes() {
    return {
      extractionMode: this.opts.extractionMode,
      paypalMode: this.opts.paypalMode,
    };
  }

  public getSession(sessionId: string): InvoiceSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }
    return session;
  }

  public async createSessionFromText(rawText: string): Promise<InvoiceSession> {
    if (!rawText || !rawText.trim()) {
      throw new Error("Please paste a client project message to extract.");
    }
    const draft = await this.opts.extractor.extractInvoice(rawText);
    const id = randomUUID();
    const now = new Date().toISOString();

    const session: InvoiceSession = {
      id,
      rawText,
      draft,
      flow: newFlow(),
      unresolvedQuestions: this.computeQuestions(draft),
      formattedPayPalPayload: this.tryBuildPayload(draft),
      paypalInvoice: null,
      extractionMode: this.opts.extractionMode,
      paypalMode: this.opts.paypalMode,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(id, session);
    return session;
  }

  public updateDraft(sessionId: string, patch: DraftUpdatePatch): InvoiceSession {
    const session = this.getSession(sessionId);
    if (session.flow.stage !== "proposed") {
      throw new Error(
        `Cannot edit extracted draft in stage "${session.flow.stage}". Create a new session to modify.`
      );
    }

    const nextDraft: ExtractedInvoiceDraft = structuredClone(session.draft);

    if (patch.recipientEmail !== undefined) {
      const email = patch.recipientEmail.trim();
      nextDraft.recipientEmail = {
        value: email || null,
        sourceSpan: nextDraft.recipientEmail.sourceSpan,
        isAmbiguous: !email,
        clarificationQuestion: email ? null : "What is the client's email address for PayPal billing?",
      };
    }

    if (patch.recipientName !== undefined) {
      const name = patch.recipientName.trim();
      nextDraft.recipientName = {
        value: name || null,
        sourceSpan: nextDraft.recipientName.sourceSpan,
        isAmbiguous: false,
        clarificationQuestion: null,
      };
    }

    if (patch.currency !== undefined) {
      const curr = patch.currency.trim().toUpperCase();
      nextDraft.currency = {
        value: curr || null,
        sourceSpan: nextDraft.currency.sourceSpan,
        isAmbiguous: !curr,
        clarificationQuestion: curr ? null : "Which currency should be used for this invoice (e.g., USD, EUR, SGD)?",
      };
      if (curr) {
        nextDraft.items = nextDraft.items.map((item) => ({
          ...item,
          unit_amount: {
            ...item.unit_amount,
            currency_code: curr,
          },
        }));
      }
    }

    if (patch.paymentTerm !== undefined) {
      nextDraft.paymentTerm = {
        value: patch.paymentTerm,
        sourceSpan: nextDraft.paymentTerm.sourceSpan,
        isAmbiguous: false,
        clarificationQuestion: null,
      };
      // Selecting an explicit payment term also resolves due-date ambiguity if no fixed date is needed
      if (patch.dueDate === undefined && !nextDraft.dueDate.value) {
        nextDraft.dueDate = {
          ...nextDraft.dueDate,
          isAmbiguous: false,
          clarificationQuestion: null,
        };
      }
    }

    if (patch.dueDate !== undefined) {
      const due = patch.dueDate ? patch.dueDate.trim() : null;
      nextDraft.dueDate = {
        value: due || null,
        sourceSpan: nextDraft.dueDate.sourceSpan,
        isAmbiguous: false,
        clarificationQuestion: null,
      };
    }

    if (patch.note !== undefined) {
      nextDraft.note = {
        value: patch.note,
        sourceSpan: null,
        isAmbiguous: false,
        clarificationQuestion: null,
      };
    }

    if (patch.items !== undefined && patch.items.length > 0) {
      const currCode = nextDraft.currency.value ?? "USD";
      nextDraft.items = patch.items.map((item, idx): InvoiceItem => ({
        name: item.name.trim() || `Deliverable ${idx + 1}`,
        description: item.description?.trim() || undefined,
        quantity: String(item.quantity).trim() || "1",
        unit_amount: {
          currency_code: currCode,
          value: String(item.unitPrice).trim() || "0.00",
        },
        sourceSpan: session.draft.items[idx]?.sourceSpan ?? null,
      }));
    }

    const validated = ExtractedInvoiceDraftSchema.parse(nextDraft);
    session.draft = validated;
    session.unresolvedQuestions = this.computeQuestions(validated);
    session.formattedPayPalPayload = this.tryBuildPayload(validated);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  /**
   * Gate 1: User explicitly approves creating a PayPal DRAFT invoice.
   * Does NOT send the invoice to the client.
   */
  public async approveAndCreateDraft(sessionId: string): Promise<InvoiceSession> {
    const session = this.getSession(sessionId);

    const missingReasons: string[] = [];
    if (!session.draft.recipientEmail.value || session.draft.recipientEmail.isAmbiguous) {
      missingReasons.push("recipientEmail");
    }
    if (!session.draft.currency.value || session.draft.currency.isAmbiguous) {
      missingReasons.push("currency");
    }
    if (
      !session.draft.items.length ||
      session.draft.items.some((it) => Number(it.unit_amount.value) <= 0)
    ) {
      missingReasons.push("positive line item amount");
    }

    if (missingReasons.length > 0) {
      throw new Error(
        `Cannot approve draft yet: please resolve missing or ambiguous required fields (${missingReasons.join(", ")}).`
      );
    }

    const payload = formatPayPalInvoiceV2Payload(session.draft, this.opts.invoicerEmail);

    // Step 1a: Transition approval state machine (throws if not in 'proposed' stage)
    const approvedFlow = approveDraft(session.flow);

    // Step 1b: Call PayPal gateway to create DRAFT
    const created = await this.opts.paypal.createDraftInvoice(payload, randomUUID());
    const fetched = await this.opts.paypal
      .getInvoice(created.id)
      .catch(() => ({ id: created.id, status: created.status ?? "DRAFT" }));

    // Step 1c: Record draft creation in state machine
    session.flow = recordDraftCreated(approvedFlow, created.id);
    session.formattedPayPalPayload = payload;
    session.paypalInvoice = this.normalizePayPalRecord(fetched);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  /**
   * Gate 2: User separately approves SENDING the already-created draft to the client.
   */
  public async approveAndSendInvoice(sessionId: string): Promise<InvoiceSession> {
    const session = this.getSession(sessionId);

    // Step 2a: Transition approval state machine (throws if draft does not exist yet)
    const approvedSendFlow = approveSend(session.flow);
    const invoiceId = session.flow.paypalInvoiceId!;

    // Step 2b: Call PayPal gateway to send invoice
    const sendResult = await this.opts.paypal.sendInvoice(invoiceId);
    const fetched = await this.opts.paypal
      .getInvoice(invoiceId)
      .catch(() => ({ id: invoiceId, status: "SENT" }));

    // Step 2c: Record sent in state machine
    session.flow = recordSent(approvedSendFlow);
    session.paypalInvoice = this.normalizePayPalRecord(fetched, sendResult);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  /**
   * Non-transactional read: fetches the latest invoice status verbatim from PayPal.
   */
  public async refreshInvoiceStatus(sessionId: string): Promise<InvoiceSession> {
    const session = this.getSession(sessionId);
    const invoiceId = session.flow.paypalInvoiceId;
    if (!invoiceId) {
      throw new Error("No PayPal invoice has been created for this session yet.");
    }
    const fetched = await this.opts.paypal.getInvoice(invoiceId);
    session.paypalInvoice = this.normalizePayPalRecord(fetched);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  /**
   * Only available in recorded_sandbox mode: simulates the sandbox buyer paying the invoice
   * so judges without live sandbox credentials can observe the SENT -> PAID status transition.
   */
  public async simulateSandboxPayment(sessionId: string): Promise<InvoiceSession> {
    const session = this.getSession(sessionId);
    if (this.opts.paypalMode !== "recorded_sandbox" || !this.opts.paypal.simulateBuyerPayment) {
      throw new Error(
        "Simulated payment is only available in Recorded Sandbox Mode. In Live Sandbox mode, pay the hosted invoice URL with your PayPal sandbox buyer account and click Refresh Status."
      );
    }
    const invoiceId = session.flow.paypalInvoiceId;
    if (!invoiceId || session.flow.stage !== "sent") {
      throw new Error("Invoice must be created and sent before simulating buyer payment.");
    }
    await this.opts.paypal.simulateBuyerPayment(invoiceId);
    return this.refreshInvoiceStatus(sessionId);
  }

  private computeQuestions(draft: ExtractedInvoiceDraft): UnresolvedQuestion[] {
    const list: UnresolvedQuestion[] = [];
    if (draft.recipientEmail.isAmbiguous && draft.recipientEmail.clarificationQuestion) {
      list.push({
        field: "recipientEmail",
        question: draft.recipientEmail.clarificationQuestion,
        required: true,
      });
    }
    if (draft.currency.isAmbiguous && draft.currency.clarificationQuestion) {
      list.push({
        field: "currency",
        question: draft.currency.clarificationQuestion,
        required: true,
      });
    }
    if (draft.paymentTerm.isAmbiguous && draft.paymentTerm.clarificationQuestion) {
      list.push({
        field: "paymentTerm",
        question: draft.paymentTerm.clarificationQuestion,
        required: false,
      });
    }
    if (draft.dueDate.isAmbiguous && draft.dueDate.clarificationQuestion) {
      list.push({
        field: "dueDate",
        question: draft.dueDate.clarificationQuestion,
        required: false,
      });
    }
    return list;
  }

  private tryBuildPayload(draft: ExtractedInvoiceDraft): Record<string, unknown> | null {
    try {
      return formatPayPalInvoiceV2Payload(draft, this.opts.invoicerEmail);
    } catch {
      return null;
    }
  }

  private normalizePayPalRecord(
    fetched: Record<string, unknown>,
    sendResult?: unknown
  ): PayPalInvoiceRecord {
    const detail = (fetched.detail as Record<string, unknown> | undefined) ?? {};
    const metadata = (detail.metadata as Record<string, unknown> | undefined) ?? {};
    const sendObj =
      typeof sendResult === "object" && sendResult !== null
        ? (sendResult as Record<string, unknown>)
        : {};

    const recipientViewUrl =
      (metadata.recipient_view_url as string | undefined) ??
      (sendObj.href as string | undefined);
    const invoicerViewUrl = metadata.invoicer_view_url as string | undefined;

    return {
      id: String(fetched.id ?? ""),
      status: String(fetched.status ?? "UNKNOWN"),
      recipientViewUrl,
      invoicerViewUrl,
      simulationMode: this.opts.paypalMode === "recorded_sandbox",
      rawResponse: fetched,
    };
  }
}
