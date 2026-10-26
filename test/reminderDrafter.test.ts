import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DeterministicReminderDrafter,
  OpenAiReminderDrafter,
} from "../src/reminderDrafter.js";
import { DeterministicExtractor } from "../src/extractor.js";

describe("ReminderDrafter — Context-Aware Reminder Generation", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("DeterministicReminderDrafter generates contextual gentle, professional, and urgent reminders", async () => {
    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(
      [
        "Client: Jordan Patel <jordan@brightwave.test>",
        "1. Discovery & UX Audit: $400 USD",
        "2. Design System Kit: $800 USD",
        "Payment terms: Net 14.",
      ].join("\n")
    );

    const drafter = new DeterministicReminderDrafter();

    const gentle = await drafter.draftReminder({
      draft,
      invoiceId: "INV2-SIM-1001",
      tone: "gentle",
    });
    expect(gentle.tone).toBe("gentle");
    expect(gentle.subject).toMatch(/friendly|reminder|INV2-SIM-1001/i);
    expect(gentle.note).toContain("Jordan Patel");
    expect(gentle.note).toContain("Discovery & UX Audit");
    expect(gentle.note).toContain("USD 1200.00");

    const professional = await drafter.draftReminder({
      draft,
      invoiceId: "INV2-SIM-1001",
      tone: "professional",
    });
    expect(professional.tone).toBe("professional");
    expect(professional.subject).toContain("INV2-SIM-1001");
    expect(professional.note).not.toBe(gentle.note);

    const urgent = await drafter.draftReminder({
      draft,
      invoiceId: "INV2-SIM-1001",
      tone: "urgent",
    });
    expect(urgent.tone).toBe("urgent");
    expect(urgent.subject).toMatch(/overdue|urgent|immediate/i);
    expect(urgent.note).toContain("INV2-SIM-1001");
  });

  it("OpenAiReminderDrafter parses LLM JSON output and falls back to deterministic drafter on invalid JSON", async () => {
    const extractor = new DeterministicExtractor();
    const draft = await extractor.extractInvoice(
      "Hi Maya, website redesign for $450 USD to maya@studio.test Net 14."
    );

    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "Quick check-in on Invoice INV2-AI-99",
                note: "Hi Maya, hope the website redesign launch went smoothly! Just following up on Invoice INV2-AI-99 for USD 450.00.",
              }),
            },
          },
        ],
      }),
    });

    const aiDrafter = new OpenAiReminderDrafter({
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    const res = await aiDrafter.draftReminder({
      draft,
      invoiceId: "INV2-AI-99",
      tone: "gentle",
    });

    expect(res.tone).toBe("gentle");
    expect(res.subject).toBe("Quick check-in on Invoice INV2-AI-99");
    expect(res.note).toContain("website redesign");

    // Non-JSON response gracefully falls back to deterministic template
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Not valid JSON" } }],
      }),
    });

    const fallbackRes = await aiDrafter.draftReminder({
      draft,
      invoiceId: "INV2-AI-99",
      tone: "urgent",
    });
    expect(fallbackRes.tone).toBe("urgent");
    expect(fallbackRes.subject).toContain("INV2-AI-99");
  });
});
