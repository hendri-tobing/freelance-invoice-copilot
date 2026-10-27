# Freelance Invoice Copilot

A human-in-the-loop PayPal Invoicing workflow for independent freelancers, built for the **PayPal AI Hackathon 2026**.

Freelancers often agree on project scope and pricing in informal client messages, then waste time manually copying details into an invoice form—or worse, send an invoice with a missing due date or wrong currency. **Freelance Invoice Copilot** turns a pasted client message into a verified PayPal invoice while keeping the freelancer in strict control of every external action.

---

## Key Differentiators

1. **Provenance Spans & Zero Guessing (`src/extractor.ts`, `src/aiExtractor.ts`, `src/schema.ts`):**
   - Every extracted field (`recipientEmail`, `recipientName`, `currency`, `paymentTerm`, `dueDate`, and multi-deliverable `items`) is mapped to its exact character offset (`sourceSpan: { start, end, text }`) in the original pasted message.
   - Missing or ambiguous fields (including unpriced or recurring list items such as `"$20/month"` or `"included"`) are **never guessed or silently dropped**; they are surfaced as explicit clarification items that must be resolved before draft creation.
2. **Enforced Three-Gate Approval Workflow (`src/approval.ts`, `src/workflow.ts`, `src/reminderDrafter.ts`):**
   - **Gate 1 (Create Draft):** Auto-saves any pending form edits, validates all required fields and line items, and calls `POST /v2/invoicing/invoices` with a deterministic `PayPal-Request-Id` idempotency key to create an editable PayPal draft (`DRAFT`). It never emails the client.
   - **Gate 2 (Send Invoice):** Requires an existing draft and a second, separate human confirmation dialog before calling `POST /v2/invoicing/invoices/{id}/send`.
   - **Gate 3 (Follow-up & Reminder Copilot):** Once an invoice is `SENT` (and not yet `PAID`), the AI Reminder Copilot drafts contextual follow-up messages in three tones (`Gentle`, `Professional`, `Urgent`) and requires explicit Gate 3 confirmation before calling `POST /v2/invoicing/invoices/{id}/remind` (rate-limited to max 2/day per invoice).
   - `InvoiceWorkflowService` enforces all three gates on the backend with per-session concurrency locks—neither the UI nor API callers can skip gates, double-submit, or spam reminders.
3. **PayPal System-of-Record Status (`src/paypal.ts`):**
   - Displays PayPal's invoice status (`DRAFT`, `SENT`, `PAID`) and hosted invoice links verbatim from the API response without inventing custom payment states.

---

## Quick Start (For Judges & Developers)

### Requirements
- **Node.js 20+** (developed and tested on Node.js 24).

### 1. Install & Run Tests
```bash
npm install
npm test          # Runs 44 unit, UI & HTTP integration tests across 8 suites
npm run typecheck # Zero-error TypeScript check
```

### 2. Launch the Interactive Web UI
```bash
npm start
```
Then open **<http://127.0.0.1:3000>** (or **<http://localhost:3000>**) in your browser.

> **Runs out-of-the-box without paid keys:**
> - If `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` are not set, the app runs in a clearly labeled **Recorded Sandbox Simulation Mode** (`RecordedPayPalGateway`) so judges can test the full *Extract → Clarify → Gate 1 (Draft) → Gate 2 (Send) → Simulate Buyer Payment (`PAID`)* flow immediately.
> - If `OPENAI_API_KEY` is not set, the app uses `DeterministicExtractor` offline fallback so no paid LLM key is required.

---

## Running with Live PayPal Sandbox & OpenAI-Compatible AI

Export your credentials in your shell (see `.env.example` for all options):

```bash
export PAYPAL_CLIENT_ID="your_sandbox_client_id"
export PAYPAL_CLIENT_SECRET="your_sandbox_client_secret"
export PAYPAL_INVOICER_EMAIL="sb-seller@personal.example.com"

# Optional: Enable live LLM extraction (OpenAI, OpenRouter, Groq, or Ollama)
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4o-mini"

npm start
```

When credentials are provided, the header badges in the Web UI automatically switch to **`Extraction: AI Model (OpenAI)`** and **`PayPal: Connected to Sandbox`**.

---

## Available Scripts

| Command | Description |
| --- | --- |
| `npm start` | Starts the Web UI and guarded HTTP API server on `http://127.0.0.1:3000` |
| `npm run dev` | Starts the server in watch mode |
| `npm test` | Runs all 8 Vitest unit, UI & integration test suites across extraction, three-gate approval, reminder drafting, PayPal client, workflow, server, and UI |
| `npm run typecheck` | Runs `tsc -p .` static type checking |
| `npm run demo` | Interactive terminal CLI walkthrough of extraction + three-gate approval lifecycle (Gate 1 Draft, Gate 2 Send, Gate 3 Reminder) |
| `npm run spike` | Live PayPal Sandbox round-trip script: create draft &rarr; fetch &rarr; send (requires sandbox credentials) |
| `npm run status -- <invoice_id>` | Read-only status fetch for a PayPal Sandbox invoice ID |

---

## Project Layout

```text
src/
  schema.ts          Zod schemas, SourceSpan provenance types, and PayPal v2 payload formatter
  extractor.ts       DeterministicExtractor (offline fallback) and exact substring span finder
  aiExtractor.ts     OpenAiExtractionProvider (LLM JSON extraction + verbatim span verification)
  reminderDrafter.ts AI & deterministic reminder drafter (Gentle, Professional, Urgent tones)
  approval.ts        Pure approval state machine (Gate 1 Draft, Gate 2 Send, Gate 3 Reminder)
  paypal.ts          PayPal Invoicing v2 REST client (OAuth 2.0 + sandbox-by-default guardrail)
  workflow.ts        Guarded InvoiceWorkflowService orchestrator + RecordedPayPalGateway
  server.ts          Zero-dependency Node.js HTTP server for REST API + Web UI (bound to 127.0.0.1)
public/
  index.html       3-step Single-Page Web UI (Source Provenance, Review Form, Approval Gates)
  styles.css       Responsive UI styling with CSS container queries & WCAG AA contrast
  app.js           Frontend state, span highlighter, multi-item editor, and API integration
  app.d.ts         TypeScript declarations for UI controller functions
scripts/
  demoCli.ts       Interactive local CLI demo
  spike.ts         PayPal Sandbox create -> send round-trip script
  status.ts        Read-only invoice status checker
test/
  approval.test.ts
  extractor.test.ts
  aiExtractor.test.ts
  reminderDrafter.test.ts
  paypal.test.ts
  workflow.test.ts
  server.test.ts
  ui.test.ts
docs/
  api-verification.md
```

---

## Why REST Instead of `@paypal/paypal-server-sdk`

`@paypal/paypal-server-sdk` v2.5.0 does not include the Invoicing v2 controller, so `src/paypal.ts` calls the official PayPal Invoicing v2 REST endpoints (`/v1/oauth2/token` and `/v2/invoicing/invoices`) directly using native `fetch`.

---

## Data, Privacy & Security

- **Fictional Data Only:** Use only fictional or redacted project agreements. Never paste real customer PII or live financial details into demos.
- **External AI Disclosure:** When `OPENAI_API_KEY` is configured, pasted text is sent to the configured OpenAI-compatible endpoint strictly for field extraction and is only held in ephemeral server memory for the active session.
- **Sandbox by Default:** `src/paypal.ts` points to `https://api-m.sandbox.paypal.com` and throws an error if pointed at live PayPal unless `PAYPAL_ALLOW_LIVE=true` is explicitly set.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
