/**
 * The local parse service.
 *
 * The browser extension cannot read authoring cues from a page's `File`
 * object — the page owns those bytes. So the bytes must move to a parser,
 * which is what this service is for.
 *
 * Design rules, all of them load-bearing:
 *
 * - **Loopback only.** The server binds to a loopback address and rejects
 *   requests from any other peer.
 * - **Never log document content.** The log records filename, size, MIME and
 *   cue counts. A user's document is not telemetry.
 * - **Errors are first-class.** `ok: false` with a reason is the normal path
 *   for "this document has no cue layer". The caller sends the original file
 *   unchanged and shows a neutral status.
 * - **No telemetry, no remote calls.** The service talks to nothing.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { extractCues } from "./index.js";

/** The wire protocol version. The extension sends this and degrades gracefully. */
export const PROTOCOL_VERSION = 1;

/** Maximum request body size. A document larger than this is refused. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Options for {@link startService}. */
export interface ServiceOptions {
  /** Port to listen on. `0` picks a free port. */
  readonly port?: number;
  /** Bind address. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Optional bearer token required on every request. */
  readonly token?: string;
  /** Maximum request body size in bytes. */
  readonly maxBodyBytes?: number;
}

/** A running service. */
export interface RunningService {
  /** The port the service is listening on. */
  readonly port: number;
  /** The address the service is listening on. */
  readonly host: string;
  /** The bearer token in force, if any. */
  readonly token?: string;
  /** Stop the service. */
  close(): Promise<void>;
}

/** Headers the extension sends. */
export const HEADER_PROTOCOL = "x-cuetap-protocol";
export const HEADER_FILENAME = "x-cuetap-filename";
export const HEADER_TOKEN = "x-cuetap-token";

/**
 * Start the local parse service.
 *
 * @param options - Service options.
 */
export async function startService(options: ServiceOptions = {}): Promise<RunningService> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const token = options.token ?? randomBytes(16).toString("hex");

  const server = createServer((req, res) => {
    void handle(req, res, { host, token, maxBodyBytes }).catch((err) => {
      sendJson(res, 500, { ok: false, reason: "internal_error", detail: errorMessage(err) });
    });
  });

  // Never let a slow client hold the process open.
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: actualPort,
    host,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

interface HandlerContext {
  readonly host: string;
  readonly token: string;
  readonly maxBodyBytes: number;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  // Loopback guard: the service is not reachable from outside the machine.
  const remote = req.socket.remoteAddress ?? "";
  if (!isLoopback(remote)) {
    sendJson(res, 403, { ok: false, reason: "forbidden", detail: "loopback clients only" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${ctx.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION, service: "cuelayer" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/version") {
    sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION, service: "cuelayer" });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/extract") {
    sendJson(res, 404, { ok: false, reason: "not_found", detail: `${req.method} ${url.pathname}` });
    return;
  }

  if (!isAuthorized(req, ctx.token)) {
    sendJson(res, 401, { ok: false, reason: "unauthorized", detail: "missing or invalid token" });
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req, ctx.maxBodyBytes);
  } catch (err) {
    // The body was refused. Stop reading but let the response through, so the
    // caller sees a 413 rather than a connection reset.
    req.pause();
    sendJson(res, 413, { ok: false, reason: "payload_too_large", detail: errorMessage(err) });
    return;
  }

  if (body.length === 0) {
    sendJson(res, 400, { ok: false, reason: "empty_document", detail: "request body was empty" });
    return;
  }

  const filename = headerValue(req, HEADER_FILENAME) ?? "document";
  const started = Date.now();
  const outcome = await extractCues(body, { buildEnriched: true });

  // Content is never logged. Filename, size and cue counts are enough to
  // diagnose a problem without touching the user's document.
  const cueCount = outcome.ok ? outcome.cues.length : 0;
  process.stdout.write(
    `cuelayer: ${filename} (${body.length} bytes) -> ${outcome.ok ? `ok, ${cueCount} cues` : outcome.reason} in ${Date.now() - started}ms\n`,
  );

  if (!outcome.ok) {
    sendJson(res, 200, {
      ok: false,
      reason: outcome.reason,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.text !== undefined ? { text: outcome.text } : {}),
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    protocol: PROTOCOL_VERSION,
    text: outcome.text,
    marked: outcome.marked,
    cues: outcome.cues,
    provenance: outcome.provenance,
    // The enriched document is returned base64 so the response stays JSON.
    // The extension splices it into the upload in place of the original.
    ...(outcome.enriched
      ? {
          enriched: Buffer.from(outcome.enriched).toString("base64"),
          enrichedType: outcome.enrichedType,
        }
      : {}),
  });
}

/** Whether the request carries the expected token. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = headerValue(req, HEADER_TOKEN);
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  const presented = header ?? bearer;
  if (!presented) return false;
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(token, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read a header value, case-insensitively. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/** Whether a socket address is a loopback address. */
function isLoopback(address: string): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

/** Read the request body, refusing anything over the limit. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        // Do not destroy the socket: the handler still needs to write a 413.
        // Pausing stops the flow; the response is written and the socket
        // closes naturally.
        req.pause();
        reject(new Error(`request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new Error("request aborted"));
    });
  });
}

/** Send a JSON response with the headers the extension expects. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    // The extension runs on a different origin; allow the read.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": `content-type,${HEADER_FILENAME},${HEADER_TOKEN},${HEADER_PROTOCOL}`,
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
