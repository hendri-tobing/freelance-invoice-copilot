// Thin REST client for PayPal Invoicing v2 (sandbox by default).
// Auth: OAuth 2.0 client credentials. Credentials come from environment variables only.

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (sandbox credentials).");
  }
  const baseUrl = env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
  if (baseUrl.includes("api-m.paypal.com") && env.PAYPAL_ALLOW_LIVE !== "true") {
    throw new Error("Refusing to use live PayPal. Set PAYPAL_ALLOW_LIVE=true only after the demo is verified.");
  }
  return { clientId, clientSecret, baseUrl };
}

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: PayPalConfig) {}

  public getBaseUrl(): string {
    return this.cfg.baseUrl;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await fetch(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal OAuth failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new Error(`PayPal ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
    }
    return json as T;
  }

  /** POST /v2/invoicing/invoices — creates a DRAFT. Not visible to the payer. */
  createDraftInvoice(invoice: unknown, requestId: string) {
    return this.request<{ id: string; status?: string; [key: string]: unknown }>("POST", "/v2/invoicing/invoices", invoice, {
      "PayPal-Request-Id": requestId,
    });
  }

  /** GET /v2/invoicing/invoices/{id} */
  getInvoice(invoiceId: string) {
    return this.request<{ id: string; status: string; detail?: Record<string, unknown>; links?: Array<{ href: string; rel: string }>; [key: string]: unknown }>(
      "GET",
      `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`
    );
  }

  /** POST /v2/invoicing/invoices/{id}/send — makes the invoice payable and emails the payer. */
  sendInvoice(invoiceId: string, sendBody: unknown = { send_to_recipient: true }) {
    return this.request<unknown>("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, sendBody);
  }
}
