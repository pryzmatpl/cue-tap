import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { parseMultipart } from "../shared/multipart.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_SCRIPT = join(HERE, "..", "content", "content.js");

/** The content script's source. */
const source = readFileSync(CONTENT_SCRIPT, "utf-8");

/** The boundary every test uses. */
const BOUNDARY = "BOUNDARY123";

/** The DOCX media type. */
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Run the content script against a fake page.
 *
 * The script is an IIFE that reads `window`, `document`, `fetch` and
 * `chrome`. This harness provides just enough of each to exercise the
 * interception path without a browser.
 */
function runInFakePage({ serviceResponse, serviceFails = false }) {
  const requests = [];
  const reported = [];
  const uploads = [];

  // The page's own fetch records what the composer tried to upload.
  const pageFetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    let body;
    if (init?.body) {
      body = new Uint8Array(init.body);
    } else {
      body = new Uint8Array(await request.arrayBuffer());
    }
    uploads.push({
      url: request.url,
      contentType: request.headers.get("content-type"),
      body,
    });
    return new Response("ok", { status: 200 });
  };

  // The service the extension talks to.
  const serviceFetch = async (url) => {
    requests.push(String(url));
    if (serviceFails) throw new Error("service unreachable");
    return new Response(JSON.stringify(serviceResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const sandbox = {
    window: {
      fetch: pageFetch,
      Request: globalThis.Request,
      Headers: globalThis.Headers,
      Response: globalThis.Response,
    },
    document: {
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      createElement() {
        return {
          style: {},
          setAttribute() {},
          appendChild() {},
          className: "",
          textContent: "",
        };
      },
    },
    fetch: serviceFetch,
    atob: globalThis.atob,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    URL: globalThis.URL,
    // The content script builds a new Request when it rewrites an upload, so
    // these must be reachable as globals in the script's scope.
    Request: globalThis.Request,
    Headers: globalThis.Headers,
    Response: globalThis.Response,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          if (message?.type === "probe") {
            return {
              active: true,
              mode: "network",
              site: { id: "test", name: "Test" },
              serviceUrl: "http://127.0.0.1:8765",
              token: "test-token",
            };
          }
          reported.push(message);
          return { ok: true };
        },
      },
    },
    HTMLInputElement: class {},
  };

  const context = createContext(sandbox);
  runInContext(source, context);

  return { requests, reported, uploads, sandbox };
}

/** Build a multipart body with one file part and one context part. */
function multipartBody(filename, fileBytes, contentType = DOCX_TYPE) {
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="context"\r\n` +
      `\r\n` +
      `the conversation context\r\n` +
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n` +
      `\r\n`,
  );
  const footer = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
  const out = new Uint8Array(header.length + fileBytes.length + footer.length);
  out.set(header, 0);
  out.set(fileBytes, header.length);
  out.set(footer, header.length + fileBytes.length);
  return out;
}

/** Extract the file part's bytes from an uploaded multipart body. */
function uploadedFileBytes(upload) {
  const parsed = parseMultipart(upload.body, BOUNDARY);
  const file = parsed.parts.find((part) => part.filename !== undefined);
  return upload.body.slice(file.start, file.end);
}

/** Extract the context part's text from an uploaded multipart body. */
function uploadedContextText(upload) {
  const parsed = parseMultipart(upload.body, BOUNDARY);
  const context = parsed.parts.find((part) => part.name === "context");
  return new TextDecoder().decode(upload.body.slice(context.start, context.end));
}

/** Build a request that posts a multipart body. */
function uploadRequest(body, extraHeaders = {}) {
  return new Request("https://chatgpt.com/backend-api/files", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      ...extraHeaders,
    },
    body,
  });
}

/** A service response with one highlight cue and an enriched document. */
function serviceResponseWithCue(enrichedBytes) {
  return {
    ok: true,
    text: "text",
    marked: "[HIGHLIGHT:YELLOW]text[/HIGHLIGHT]",
    cues: [{ kind: "highlight", value: "yellow", start: 0, end: 4, text: "text" }],
    provenance: {
      cuesFound: 1,
      cuesPreserved: 1,
      cuesDropped: [],
      parts: [],
      truncated: false,
    },
    enriched: Buffer.from(enrichedBytes).toString("base64"),
  };
}

describe("the content script", () => {
  it("does nothing on a site that is not supported", async () => {
    const sandbox = {
      window: { fetch: async () => new Response("ok"), Request, Headers, Response },
      document: { addEventListener() {}, querySelectorAll: () => [] },
      chrome: {
        runtime: {
          sendMessage: async (message) =>
            message?.type === "probe" ? { active: false } : { ok: true },
        },
      },
    };
    const context = createContext(sandbox);
    runInContext(source, context);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The page's fetch must not have been replaced.
    expect(sandbox.window.fetch.__cuetapHooked).toBeUndefined();
  });

  it("intercepts a multipart upload and asks the service to enrich it", async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const enriched = new Uint8Array([9, 9, 9, 9, 9, 9]);
    const body = multipartBody("policy.docx", original);

    const run = runInFakePage({ serviceResponse: serviceResponseWithCue(enriched) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(uploadRequest(body));

    // The service was asked to enrich the document.
    expect(run.requests.some((url) => url.endsWith("/extract"))).toBe(true);

    // The upload carried the enriched bytes.
    expect(run.uploads.length).toBe(1);
    const uploaded = run.uploads[0];
    expect(uploadedFileBytes(uploaded)).toEqual(enriched);

    // The badge was told the cue count.
    expect(run.reported.some((message) => message.state === "attached")).toBe(true);
  });

  it("preserves every other part of the upload byte-for-byte", async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const enriched = new Uint8Array([9, 9, 9, 9, 9, 9]);
    const body = multipartBody("policy.docx", original);

    const run = runInFakePage({ serviceResponse: serviceResponseWithCue(enriched) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(uploadRequest(body));

    const uploaded = run.uploads[0];
    expect(uploadedContextText(uploaded)).toBe("the conversation context");
    // The file part's headers survive too.
    const parsed = parseMultipart(uploaded.body, BOUNDARY);
    const file = parsed.parts.find((part) => part.filename !== undefined);
    expect(file.filename).toBe("policy.docx");
    expect(file.contentType).toBe(DOCX_TYPE);
  });

  it("passes the upload through untouched when there are no cues", async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const body = multipartBody("policy.docx", original);

    const run = runInFakePage({
      serviceResponse: {
        ok: true,
        text: "text",
        marked: "text",
        cues: [],
        provenance: { cuesFound: 0, cuesPreserved: 0, cuesDropped: [], parts: [], truncated: false },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(uploadRequest(body));

    expect(uploadedFileBytes(run.uploads[0])).toEqual(original);
  });

  it("passes a non-multipart request through untouched", async () => {
    const run = runInFakePage({ serviceResponse: { ok: true, cues: [] } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(
      new Request("https://chatgpt.com/api/conversation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
    );

    expect(run.requests.length).toBe(0);
    expect(run.uploads.length).toBe(1);
  });

  it("passes a signed upload through untouched", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const body = multipartBody("policy.docx", original);

    const run = runInFakePage({
      serviceResponse: serviceResponseWithCue(new Uint8Array([9])),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(uploadRequest(body, { "content-md5": "signature" }));

    // The service must not even be asked: the upload cannot be rewritten.
    expect(run.requests.length).toBe(0);
    expect(uploadedFileBytes(run.uploads[0])).toEqual(original);
  });

  it("passes a chunked upload through untouched", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const body = multipartBody("policy.docx", original);

    const run = runInFakePage({
      serviceResponse: serviceResponseWithCue(new Uint8Array([9])),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(uploadRequest(body, { "transfer-encoding": "chunked" }));

    expect(run.requests.length).toBe(0);
    expect(uploadedFileBytes(run.uploads[0])).toEqual(original);
  });

  it("passes the upload through untouched when the service is unreachable", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const body = multipartBody("policy.docx", original);

    const run = runInFakePage({ serviceResponse: {}, serviceFails: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(uploadRequest(body));

    expect(uploadedFileBytes(run.uploads[0])).toEqual(original);
  });

  it("leaves a non-DOCX file untouched", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const body = multipartBody("scan.pdf", original, "application/pdf");

    const run = runInFakePage({
      serviceResponse: serviceResponseWithCue(new Uint8Array([9])),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await run.sandbox.window.fetch(uploadRequest(body));

    // PDF cues cannot be recovered yet; the file must go through unchanged.
    expect(run.requests.length).toBe(0);
    expect(uploadedFileBytes(run.uploads[0])).toEqual(original);
  });
});
