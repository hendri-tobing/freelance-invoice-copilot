import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkflowServiceFromEnv,
  DraftUpdatePatch,
  HttpError,
  InvoiceWorkflowService,
  SAMPLE_SCENARIOS,
} from "./workflow.js";
import { ReminderTone } from "./approval.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON request body.");
  }
}

function getErrorStatus(err: unknown): number {
  if (err instanceof HttpError) {
    return err.statusCode;
  }
  return 400;
}

export function createAppServer(
  workflow: InvoiceWorkflowService = createWorkflowServiceFromEnv()
): Server {
  return createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      // 1. GET /api/config
      if (method === "GET" && pathname === "/api/config") {
        return sendJson(res, 200, {
          modes: workflow.getModes(),
          scenarios: SAMPLE_SCENARIOS,
        });
      }

      // 2. POST /api/sessions/extract
      if (method === "POST" && pathname === "/api/sessions/extract") {
        const body = await readJsonBody<{ rawText?: string }>(req);
        const session = await workflow.createSessionFromText(body.rawText ?? "");
        return sendJson(res, 201, session);
      }

      // 3. Session routes: /api/sessions/:id...
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2];

        if (method === "GET" && !action) {
          const session = workflow.getSession(sessionId);
          return sendJson(res, 200, session);
        }

        if (method === "PATCH" && action === "draft") {
          const patch = await readJsonBody<DraftUpdatePatch>(req);
          const session = workflow.updateDraft(sessionId, patch);
          return sendJson(res, 200, session);
        }

        if (method === "POST" && action === "approve-draft") {
          const session = await workflow.approveAndCreateDraft(sessionId);
          return sendJson(res, 200, session);
        }

        if (method === "POST" && action === "approve-send") {
          const session = await workflow.approveAndSendInvoice(sessionId);
          return sendJson(res, 200, session);
        }

        if (method === "POST" && action === "refresh-status") {
          const session = await workflow.refreshInvoiceStatus(sessionId);
          return sendJson(res, 200, session);
        }

        if (method === "POST" && action === "simulate-pay") {
          const session = await workflow.simulateSandboxPayment(sessionId);
          return sendJson(res, 200, session);
        }
      }

      // 3b. Gate 3 Reminder routes: /api/sessions/:id/remind/(draft|approve-send)
      const remindMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/remind\/(draft|approve-send)$/);
      if (remindMatch && method === "POST") {
        const sessionId = decodeURIComponent(remindMatch[1]);
        const remindAction = remindMatch[2];

        if (remindAction === "draft") {
          const body = await readJsonBody<{ tone?: ReminderTone }>(req);
          const drafted = await workflow.draftReminder(sessionId, body.tone ?? "gentle");
          return sendJson(res, 200, drafted);
        }

        if (remindAction === "approve-send") {
          const body = await readJsonBody<{
            subject?: string;
            note?: string;
            tone?: ReminderTone;
          }>(req);
          const session = await workflow.approveAndSendReminder(sessionId, {
            subject: body.subject ?? "",
            note: body.note ?? "",
            tone: body.tone ?? "gentle",
          });
          return sendJson(res, 200, session);
        }
      }

      // 4. Static files in public/ (strictly confined via path.relative)
      if (method === "GET") {
        const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const safePath = resolve(join(PUBLIC_DIR, relPath));
        const relToPublic = relative(PUBLIC_DIR, safePath);
        if (relToPublic.startsWith("..") || isAbsolute(relToPublic)) {
          return sendJson(res, 403, { error: "Forbidden" });
        }
        try {
          const content = await readFile(safePath);
          const ext = extname(safePath);
          res.writeHead(200, {
            "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
            "Cache-Control": "no-store",
          });
          res.end(content);
          return;
        } catch {
          return sendJson(res, 404, { error: `Not found: ${pathname}` });
        }
      }

      return sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });
    } catch (err) {
      const status = getErrorStatus(err);
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, status, { error: message });
    }
  });
}

// Run server directly if invoked via `tsx src/server.ts`
const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const workflow = createWorkflowServiceFromEnv();
  const server = createAppServer(workflow);
  server.listen(port, host, () => {
    const modes = workflow.getModes();
    console.log("==========================================================");
    console.log("  Freelance Invoice Copilot — Web UI & Guarded API Server ");
    console.log("==========================================================");
    console.log(`  URL:             http://${host}:${port}`);
    console.log(`  Extraction Mode: ${modes.extractionMode.toUpperCase()}`);
    console.log(`  PayPal Mode:     ${modes.paypalMode.toUpperCase()}`);
    console.log("==========================================================");
  });
}
