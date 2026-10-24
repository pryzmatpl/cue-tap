/**
 * Multipart body inspection and rewriting.
 *
 * When CueTap intercepts an upload it must do three things correctly:
 *
 * 1. Find the file part inside a `multipart/form-data` body.
 * 2. Replace it with the enriched document, if the format supports that.
 * 3. Leave every other part byte-for-byte identical.
 *
 * The third point is the one that is easy to get wrong and hard to notice.
 * A composer posting a conversation context, an image and a document expects
 * all three to arrive intact. This parser therefore reports byte ranges for
 * each part and rewrites by splicing, rather than by re-serialising.
 *
 * This file is plain JavaScript with JSDoc types: it ships inside a Chrome
 * extension, where no build step runs.
 */

/**
 * One part of a multipart body.
 *
 * @typedef {Object} MultipartPart
 * @property {string|undefined} name - The part's `Content-Disposition` name.
 * @property {string|undefined} filename - The part's filename.
 * @property {string|undefined} contentType - The part's `Content-Type`.
 * @property {Record<string,string>} headers - The raw headers, lower-cased.
 * @property {number} start - Byte offset of the body within the buffer.
 * @property {number} end - Exclusive end of the body within the buffer.
 */

/**
 * The parsed shape of a multipart body.
 *
 * @typedef {Object} MultipartBody
 * @property {string} boundary - The boundary, without the leading dashes.
 * @property {MultipartPart[]} parts - The parts, in order.
 */

/**
 * Parse the boundary out of a `Content-Type` header value.
 *
 * @param {string|null|undefined} contentType - The raw header value.
 * @returns {string|undefined} The boundary, or `undefined` when the value is
 *   not multipart.
 */
export function parseBoundary(contentType) {
  if (!contentType) return undefined;
  if (!/^multipart\//i.test(contentType.trim())) return undefined;
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) return undefined;
  const boundary = match[1] ?? match[2];
  return boundary ? boundary : undefined;
}

/**
 * Find the byte offsets of every part in a multipart body.
 *
 * @param {Uint8Array} body - The raw body bytes.
 * @param {string} boundary - The boundary, without leading dashes.
 * @returns {MultipartBody|undefined} The parsed body.
 */
export function parseMultipart(body, boundary) {
  const delimiter = new TextEncoder().encode(`--${boundary}`);

  const positions = findDelimiters(body, delimiter);
  if (positions.length < 2) return undefined;

  const parts = [];

  for (let i = 0; i < positions.length - 1; i += 1) {
    const delimiterStart = positions[i];

    // A closing delimiter is `--boundary--`; it has no headers.
    if (isClosingDelimiter(body, delimiterStart, delimiter.length)) break;

    // The header block begins after the delimiter line.
    let cursor = delimiterStart + delimiter.length;
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2;
    else if (body[cursor] === 0x0a) cursor += 1;

    const nextDelimiter = positions[i + 1];
    // The part ends at the CRLF that precedes the next delimiter.
    let bodyEnd = nextDelimiter;
    if (bodyEnd >= 2 && body[bodyEnd - 2] === 0x0d && body[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    else if (bodyEnd >= 1 && body[bodyEnd - 1] === 0x0a) bodyEnd -= 1;

    const headerEnd = findHeaderEnd(body, cursor, bodyEnd);
    if (headerEnd === undefined) continue;

    const headerText = new TextDecoder().decode(body.subarray(cursor, headerEnd.headerEnd));
    const headers = parseHeaders(headerText);
    const disposition = headers["content-disposition"] ?? "";

    const name = nameFromDisposition(disposition);
    const filename = filenameFromDisposition(disposition);
    const contentType = headers["content-type"];

    parts.push({
      ...(name !== undefined ? { name } : {}),
      ...(filename !== undefined ? { filename } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      headers,
      start: headerEnd.bodyStart,
      end: bodyEnd,
    });
  }

  return { boundary, parts };
}

/**
 * Whether the delimiter at this offset is the closing one.
 *
 * @param {Uint8Array} body
 * @param {number} index
 * @param {number} delimiterLength
 * @returns {boolean}
 */
function isClosingDelimiter(body, index, delimiterLength) {
  return body[index + delimiterLength] === 0x2d && body[index + delimiterLength + 1] === 0x2d;
}

/**
 * Locate the end of a part's header block.
 *
 * @param {Uint8Array} body
 * @param {number} from
 * @param {number} limit
 * @returns {{headerEnd:number, bodyStart:number}|undefined}
 */
function findHeaderEnd(body, from, limit) {
  for (let i = from; i < limit - 1; i += 1) {
    if (body[i] === 0x0d && body[i + 1] === 0x0a && body[i + 2] === 0x0d && body[i + 3] === 0x0a) {
      return { headerEnd: i, bodyStart: i + 4 };
    }
    if (body[i] === 0x0a && body[i + 1] === 0x0a) {
      return { headerEnd: i, bodyStart: i + 2 };
    }
  }
  return undefined;
}

/**
 * Parse a header block into a lower-cased map.
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = value;
  }
  return headers;
}

/**
 * Extract the `name` parameter from a `Content-Disposition` header.
 *
 * @param {string} disposition
 * @returns {string|undefined}
 */
export function nameFromDisposition(disposition) {
  return dispositionParam(disposition, "name");
}

/**
 * Extract the `filename` parameter from a `Content-Disposition` header.
 *
 * @param {string} disposition
 * @returns {string|undefined}
 */
export function filenameFromDisposition(disposition) {
  return dispositionParam(disposition, "filename");
}

/**
 * Extract a quoted parameter from a header value.
 *
 * @param {string} disposition
 * @param {string} parameter
 * @returns {string|undefined}
 */
function dispositionParam(disposition, parameter) {
  const quoted = new RegExp(`${parameter}\\s*=\\s*"([^"]*)"`, "i").exec(disposition);
  if (quoted) return quoted[1];
  const bare = new RegExp(`${parameter}\\s*=\\s*([^;\s]+)`, "i").exec(disposition);
  return bare?.[1];
}

/**
 * Find the file part in a multipart body.
 *
 * @param {MultipartBody} parsed - The parsed body.
 * @param {string[]} [candidates] - Filename extensions to accept.
 * @returns {MultipartPart|undefined}
 */
export function findFilePart(parsed, candidates = [".docx"]) {
  const withFilename = parsed.parts.filter((part) => part.filename !== undefined);
  if (withFilename.length === 0) return undefined;
  if (withFilename.length === 1) return withFilename[0];

  // Prefer a part whose extension matches, then the largest — a document
  // next to a small image is the document the user meant.
  const matching = withFilename.find((part) => {
    const filename = part.filename.toLowerCase();
    return candidates.some((extension) => filename.endsWith(extension));
  });
  if (matching) return matching;

  return withFilename.reduce((largest, part) =>
    part.end - part.start > largest.end - largest.start ? part : largest,
  );
}

/**
 * Replace one part's body with new bytes, leaving every other byte alone.
 *
 * @param {Uint8Array} body - The original body.
 * @param {MultipartPart} part - The part to replace.
 * @param {Uint8Array} replacement - The new bytes.
 * @returns {Uint8Array} The rewritten body.
 */
export function replacePartBody(body, part, replacement) {
  const out = new Uint8Array(body.length - (part.end - part.start) + replacement.length);
  let cursor = 0;
  out.set(body.subarray(0, part.start), cursor);
  cursor += part.start;
  out.set(replacement, cursor);
  cursor += replacement.length;
  out.set(body.subarray(part.end), cursor);
  return out;
}

/**
 * Whether the request body looks like a multipart upload we can handle.
 *
 * @param {string|null|undefined} contentType
 * @returns {boolean}
 */
export function isMultipartUpload(contentType) {
  return parseBoundary(contentType) !== undefined;
}

/**
 * Whether the request appears to be signed or otherwise non-rewritable.
 *
 * Some composers compute a checksum or signature over the body before
 * posting. Rewriting the body would invalidate it, and the upload would fail.
 * When that is detected, CueTap must fall back rather than break the upload.
 *
 * @param {Record<string,string>} headers
 * @returns {boolean}
 */
export function hasBodySignature(headers) {
  const signatureHeaders = [
    "content-md5",
    "x-content-sha256",
    "x-content-md5",
    "x-amz-content-sha256",
    "x-ms-content-sha256",
    "x-signature",
    "x-body-signature",
    "digest",
  ];
  return signatureHeaders.some((name) => headers[name] !== undefined);
}

/**
 * Whether the upload is chunked.
 *
 * A chunked upload can split one file across several requests, so a single
 * interception cannot enrich it. CueTap must detect this and fall back.
 *
 * @param {Record<string,string>} headers
 * @returns {boolean}
 */
export function isChunkedUpload(headers) {
  const encoding = headers["transfer-encoding"];
  if (!encoding) return false;
  return encoding.toLowerCase().includes("chunked");
}

/**
 * Find every real delimiter in a multipart body.
 *
 * A delimiter is the boundary preceded by the start of the body or by a
 * line break, and followed by a line break or the closing `--`. Without
 * those checks, a part whose *content* mentions the boundary string would
 * be mistaken for a delimiter and the part would be truncated.
 *
 * @param {Uint8Array} haystack
 * @param {Uint8Array} needle - The `--boundary` bytes.
 * @returns {number[]} The offsets of each real delimiter.
 */
function findDelimiters(haystack, needle) {
  const out = [];
  if (needle.length === 0) return out;

  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }

    // The delimiter must start a line.
    if (i > 0) {
      const before = haystack[i - 1];
      const startsLine = before === 0x0a || before === 0x0d;
      if (!startsLine) continue;
    }

    // And it must end the line (or be the closing delimiter).
    const after = haystack[i + needle.length];
    const endsLine = after === undefined || after === 0x0a || after === 0x0d;
    const isClosing = after === 0x2d && haystack[i + needle.length + 1] === 0x2d;
    if (!endsLine && !isClosing) continue;

    out.push(i);
  }
  return out;
}
