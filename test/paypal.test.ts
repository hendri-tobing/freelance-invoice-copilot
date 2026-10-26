import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, PayPalClient, PayPalConfig } from "../src/paypal.js";

describe("PayPalClient REST implementation against mock sandbox responses", () => {
  const config: PayPalConfig = {
    clientId: "test_client_id",
    clientSecret: "test_client_secret",
    baseUrl: "https://api-m.sandbox.paypal.com",
  };

  let client: PayPalClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new PayPalClient(config);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("blocks live or non-sandbox PayPal base URLs unless PAYPAL_ALLOW_LIVE=true", () => {
    expect(() =>
      loadConfig({
        PAYPAL_CLIENT_ID: "id",
        PAYPAL_CLIENT_SECRET: "secret",
        PAYPAL_BASE_URL: "https://api-m.paypal.com",
      })
    ).toThrow(/Refusing to use non-sandbox PayPal URL/);

    expect(() =>
      loadConfig({
        PAYPAL_CLIENT_ID: "id",
        PAYPAL_CLIENT_SECRET: "secret",
        PAYPAL_BASE_URL: "https://api.paypal.com",
      })
    ).toThrow(/Refusing to use non-sandbox PayPal URL/);

    const allowed = loadConfig({
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_BASE_URL: "https://api-m.paypal.com",
      PAYPAL_ALLOW_LIVE: "true",
    });
    expect(allowed.baseUrl).toBe("https://api-m.paypal.com");
  });

  it("authenticates via OAuth 2.0 and creates draft invoice with expected headers", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    // 1. Mock OAuth response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "mock_access_token_12345",
        expires_in: 32400,
      }),
    });

    // 2. Mock POST /v2/invoicing/invoices response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          id: "INV2-DRAFT-9999",
          status: "DRAFT",
          href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-DRAFT-9999",
        }),
    });

    const result = await client.createDraftInvoice(
      {
        detail: { currency_code: "USD" },
      },
      "req-uuid-1"
    );

    expect(result.id).toBe("INV2-DRAFT-9999");
    expect(result.status).toBe("DRAFT");

    // Verify first call was OAuth
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=client_credentials",
      })
    );

    // Verify second call was POST invoices with Bearer and PayPal-Request-Id
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer mock_access_token_12345",
          "PayPal-Request-Id": "req-uuid-1",
        }),
      })
    );
  });

  it("sends an existing draft invoice via POST /v2/invoicing/invoices/{id}/send", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Mock OAuth token reuse or fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "mock_token_abc",
        expires_in: 3600,
      }),
    });

    // Mock Send Invoice response (PayPal returns HTTP 202 or 200 with href)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ rel: "self", method: "GET" }),
    });

    await client.sendInvoice("INV2-DRAFT-9999");

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-DRAFT-9999/send",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("sends an invoice reminder via POST /v2/invoicing/invoices/{id}/remind (HTTP 204) and surfaces API errors", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    // 1. OAuth
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "mock_token_remind",
        expires_in: 3600,
      }),
    });

    // 2. HTTP 204 No Content response from /remind
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => "",
    });

    const notification = {
      subject: "Gentle reminder: Invoice INV2-DRAFT-9999",
      note: "Hi Jordan, quick check-in on the invoice.",
      send_to_invoicer: true,
      send_to_recipient: true,
      additional_recipients: [],
    };

    await client.sendInvoiceReminder("INV2-DRAFT-9999", notification);

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-DRAFT-9999/remind",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(notification),
      })
    );

    // 3. HTTP 422 error when invoice is already paid or rate-limited
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "Max reminders exceeded" }),
    });

    await expect(client.sendInvoiceReminder("INV2-DRAFT-9999", notification)).rejects.toThrow(
      /HTTP 422.*Max reminders exceeded/
    );
  });
});
