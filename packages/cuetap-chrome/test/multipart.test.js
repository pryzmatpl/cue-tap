import { describe, expect, it } from "vitest";
import {
  findFilePart,
  hasBodySignature,
  isChunkedUpload,
  parseBoundary,
  parseMultipart,
  parseHeaders,
  replacePartBody,
} from "../shared/multipart.js";

/** Build a multipart body from parts. */
function buildMultipart(boundary, parts) {
  const chunks = [];
  const encoder = new TextEncoder();
  for (const part of parts) {
    let headers = `--${boundary}\r\n`;
    if (part.name || part.filename) {
      const disposition = [
        part.name ? `name="${part.name}"` : undefined,
        part.filename ? `filename="${part.filename}"` : undefined,
      ]
        .filter(Boolean)
        .join("; ");
      headers += `Content-Disposition: form-data; ${disposition}\r\n`;
    }
    if (part.type) headers += `Content-Type: ${part.type}\r\n`;
    headers += "\r\n";
    chunks.push(encoder.encode(headers));
    chunks.push(encoder.encode(part.body));
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("multipart parsing", () => {
  it("extracts the boundary from a content-type header", () => {
    expect(parseBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(parseBoundary('multipart/form-data; boundary="a b c"')).toBe("a b c");
    expect(parseBoundary("multipart/form-data; boundary=xyz; charset=utf-8")).toBe("xyz");
  });

  it("returns undefined for a non-multipart content type", () => {
    expect(parseBoundary("application/json")).toBeUndefined();
    expect(parseBoundary("text/plain")).toBeUndefined();
    expect(parseBoundary(null)).toBeUndefined();
    expect(parseBoundary("multipart/form-data")).toBeUndefined();
  });

  it("finds every part and its byte range", () => {
    const body = buildMultipart("B0UND", [
      { name: "purpose", body: "vision" },
      { name: "file", filename: "policy.docx", type: DOCX_TYPE, body: "DOCXBYTES" },
    ]);

    const parsed = parseMultipart(body, "B0UND");
    expect(parsed).toBeDefined();
    expect(parsed.parts).toHaveLength(2);

    const file = parsed.parts[1];
    expect(file.name).toBe("file");
    expect(file.filename).toBe("policy.docx");
    expect(file.contentType).toContain("wordprocessingml");
    expect(new TextDecoder().decode(body.subarray(file.start, file.end))).toBe("DOCXBYTES");
  });

  it("preserves the exact bytes of every other part when rewriting", () => {
    const body = buildMultipart("B0UND", [
      { name: "context", body: "the conversation context" },
      { name: "file", filename: "policy.docx", body: "ORIGINALDOCX" },
      { name: "image", filename: "logo.png", type: "image/png", body: "PNGBYTES" },
    ]);

    const parsed = parseMultipart(body, "B0UND");
    const file = findFilePart(parsed);
    const rewritten = replacePartBody(body, file, new TextEncoder().encode("ENRICHEDDOCX"));

    const parsedAfter = parseMultipart(rewritten, "B0UND");
    expect(parsedAfter.parts).toHaveLength(3);

    const context = parsedAfter.parts[0];
    expect(new TextDecoder().decode(rewritten.subarray(context.start, context.end))).toBe(
      "the conversation context",
    );

    const image = parsedAfter.parts[2];
    expect(new TextDecoder().decode(rewritten.subarray(image.start, image.end))).toBe("PNGBYTES");

    const newFile = parsedAfter.parts[1];
    expect(new TextDecoder().decode(rewritten.subarray(newFile.start, newFile.end))).toBe(
      "ENRICHEDDOCX",
    );
  });

  it("keeps the part headers when rewriting", () => {
    const body = buildMultipart("B0UND", [
      { name: "file", filename: "policy.docx", type: DOCX_TYPE, body: "OLD" },
    ]);

    const parsed = parseMultipart(body, "B0UND");
    const file = findFilePart(parsed);
    const rewritten = replacePartBody(body, file, new TextEncoder().encode("NEW"));

    const parsedAfter = parseMultipart(rewritten, "B0UND");
    expect(parsedAfter.parts[0].filename).toBe("policy.docx");
    expect(parsedAfter.parts[0].contentType).toContain("wordprocessingml");
  });

  it("prefers a docx part when several files are present", () => {
    const body = buildMultipart("B0UND", [
      { name: "image", filename: "logo.png", type: "image/png", body: "PNG" },
      { name: "file", filename: "policy.docx", body: "DOCX" },
    ]);

    const parsed = parseMultipart(body, "B0UND");
    const file = findFilePart(parsed);
    expect(file.filename).toBe("policy.docx");
  });

  it("returns undefined when there is no file part", () => {
    const body = buildMultipart("B0UND", [{ name: "purpose", body: "vision" }]);
    const parsed = parseMultipart(body, "B0UND");
    expect(findFilePart(parsed)).toBeUndefined();
  });

  it("returns undefined for a body with no parts", () => {
    expect(parseMultipart(new TextEncoder().encode("not multipart"), "B0UND")).toBeUndefined();
  });

  it("does not mistake a boundary mention inside a part body for a delimiter", () => {
    const body = buildMultipart("B0UND", [
      { name: "context", body: "mentions --B0UND inside" },
      { name: "file", filename: "a.docx", body: "DATA" },
    ]);

    const parsed = parseMultipart(body, "B0UND");
    expect(parsed).toBeDefined();
    expect(parsed.parts).toHaveLength(2);
    expect(new TextDecoder().decode(body.subarray(parsed.parts[0].start, parsed.parts[0].end))).toBe(
      "mentions --B0UND inside",
    );
  });

  it("parses headers into a lower-cased map", () => {
    const headers = parseHeaders("Content-Type: text/plain\r\nX-Custom: value\r\n");
    expect(headers["content-type"]).toBe("text/plain");
    expect(headers["x-custom"]).toBe("value");
  });

  it("detects a body signature that would break a rewrite", () => {
    expect(hasBodySignature({ "content-md5": "abc" })).toBe(true);
    expect(hasBodySignature({ "x-amz-content-sha256": "abc" })).toBe(true);
    expect(hasBodySignature({ "content-type": "multipart/form-data" })).toBe(false);
  });

  it("detects a chunked upload", () => {
    expect(isChunkedUpload({ "transfer-encoding": "chunked" })).toBe(true);
    expect(isChunkedUpload({ "transfer-encoding": "gzip, chunked" })).toBe(true);
    expect(isChunkedUpload({ "transfer-encoding": "gzip" })).toBe(false);
    expect(isChunkedUpload({})).toBe(false);
  });
});
