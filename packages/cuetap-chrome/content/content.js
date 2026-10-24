/**
 * CueTap content script.
 *
 * Runs in the page's own world so it can wrap `fetch` and `XMLHttpRequest`
 * before the composer builds its upload request.
 *
 * Two modes:
 *
 * - **network** — the composer posts the file bytes over HTTP. CueTap
 *   intercepts the request, extracts the file part, asks the local service
 *   for the cue-preserving version, and splices it back in. Every other
 *   part of the request is preserved byte-for-byte.
 *
 * - **input** — the composer reads the file client-side and never posts the
 *   raw bytes. Nothing can rewrite that upload. CueTap attaches the
 *   cue-preserving text alongside the file instead, and says so.
 *
 * The script never sends document content anywhere except the loopback
 * service and the composer the user chose.
 *
 * Plain JavaScript with JSDoc types: it ships inside a Chrome extension,
 * where no build step runs.
 */

(() => {
  const state = {
    /** Whether the site is supported at all. */
    active: false,
    /** The interception mode for this site. */
    mode: "unknown",
    /** The local parse service. */
    serviceUrl: "",
    /** The bearer token for the local service. */
    token: "",
    /** The name of the site, for display. */
    siteName: "",
  };

  /** Ask the background worker what to do on this page. */
  async function probe() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "probe" });
      if (!response?.active) {
        state.active = false;
        return;
      }
      state.active = true;
      state.mode = response.mode ?? "unknown";
      state.serviceUrl = response.serviceUrl ?? "";
      state.token = response.token ?? "";
      state.siteName = response.site?.name ?? "";
    } catch {
      state.active = false;
    }
  }

  /**
   * Ask the local service to enrich a document.
   *
   * @param {Uint8Array} bytes - The document bytes.
   * @param {string} filename - The document's filename.
   * @returns {Promise<object|null>} The extraction result, or null on failure.
   */
  async function enrich(bytes, filename) {
    if (!state.serviceUrl) return null;
    try {
      const response = await fetch(`${state.serviceUrl}/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-cuetap-filename": filename,
          "x-cuetap-token": state.token,
          "x-cuetap-protocol": "1",
        },
        body: bytes,
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body?.ok ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Report the outcome to the background worker, for the badge.
   *
   * @param {"active"|"attached"|"idle"|"error"} stateName
   * @param {number} [count]
   */
  function report(stateName, count) {
    try {
      void chrome.runtime.sendMessage({ type: "report", state: stateName, count });
    } catch {
      // The worker may be asleep. Not important enough to fail the upload.
    }
  }

  /**
   * Whether a file names a format CueTap can enrich in place.
   *
   * Only DOCX can be rewritten. A PDF's cue layer cannot be recovered yet,
   * and rewriting a PDF with a DOCX would corrupt the upload.
   *
   * @param {string} contentType
   * @param {string} filename
   * @returns {boolean}
   */
  function isEnrichable(contentType, filename) {
    const type = (contentType ?? "").toLowerCase();
    const name = (filename ?? "").toLowerCase();
    if (type.includes("wordprocessingml") || name.endsWith(".docx")) return true;
    return false;
  }

  /**
   * Wrap `fetch` so multipart uploads can be intercepted.
   *
   * The wrapper is intentionally conservative: it only touches requests that
   * are multipart uploads carrying a file part CueTap can enrich. Everything
   * else passes through untouched, byte-for-byte.
   */
  function installFetchHook() {
    const originalFetch = window.fetch.bind(window);
    if (originalFetch.__cuetapHooked) return;

    const hooked = async function (input, init) {
      try {
        const request = normalizeRequest(input, init);
        if (!request) return originalFetch(input, init);

        const contentType = request.headers.get("content-type");
        const boundary = getBoundary(contentType);
        if (!boundary) return originalFetch(input, init);

        // A signed or chunked upload cannot be rewritten safely.
        if (hasBodySignature(headersToObject(request.headers))) return originalFetch(input, init);
        if (isChunkedUpload(headersToObject(request.headers))) return originalFetch(input, init);

        const body = await readRequestBody(request);
        if (!body || body.length === 0) return originalFetch(input, init);

        const parsed = parseMultipartLocal(body, boundary);
        if (!parsed) return originalFetch(input, init);

        const filePart = findFilePartLocal(parsed);
        if (!filePart) return originalFetch(input, init);

        const filename = filePart.filename ?? "";
        if (!isEnrichable(filePart.contentType, filename)) {
          // Nothing to enrich in place. The file still uploads unchanged.
          return originalFetch(input, init);
        }

        const fileBytes = body.subarray(filePart.start, filePart.end);
        const result = await enrich(fileBytes, filename);
        if (!result || !result.cues || result.cues.length === 0) {
          report("idle");
          return originalFetch(input, init);
        }

        // The service returns the enriched document as base64. A composer
        // expects a document, so the upload is replaced with the enriched
        // file — never with a text rendering of it.
        if (!result.enriched) {
          report("idle");
          return originalFetch(input, init);
        }
        const enrichedBytes = base64ToBytes(result.enriched);

        const rewritten = replacePartLocal(body, filePart, enrichedBytes);
        report("attached", result.cues.length);

        // Rebuild the request with the new body. Headers that describe the
        // body length must be corrected.
        const newHeaders = new Headers(request.headers);
        newHeaders.delete("content-length");

        return originalFetch(
          new Request(request.url, {
            method: request.method,
            headers: newHeaders,
            body: rewritten,
            // Preserve the original request's context.
            credentials: request.credentials,
            mode: request.mode,
            cache: request.cache,
            redirect: request.redirect,
            referrer: request.referrer,
            referrerPolicy: request.referrerPolicy,
            integrity: request.integrity,
            keepalive: request.keepalive,
            signal: request.signal,
          }),
        );
      } catch {
        // Any failure means the original request proceeds untouched. A
        // broken upload would be far worse than a missing cue.
        return originalFetch(input, init);
      }
    };

    hooked.__cuetapHooked = true;
    window.fetch = hooked;
  }

  /**
   * Normalise the two ways `fetch` can be called into one Request.
   *
   * @param {Request|string|URL} input
   * @param {RequestInit} [init]
   * @returns {Request|null}
   */
  function normalizeRequest(input, init) {
    try {
      if (input instanceof Request) {
        return init ? new Request(input, init) : input;
      }
      if (typeof input === "string" || input instanceof URL) {
        return new Request(input, init);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read a request's body as bytes.
   *
   * A body that is a stream cannot be read twice — the original request
   * would break — so those are passed through untouched.
   *
   * @param {Request} request
   * @returns {Promise<Uint8Array|null>}
   */
  async function readRequestBody(request) {
    try {
      const buffer = await request.clone().arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  /**
   * Convert a Headers object to a plain lower-cased object.
   *
   * @param {Headers} headers
   * @returns {Record<string,string>}
   */
  function headersToObject(headers) {
    const out = {};
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }

  /**
   * Whether the request appears to be signed.
   *
   * @param {Record<string,string>} headers
   * @returns {boolean}
   */
  function hasBodySignature(headers) {
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
   * @param {Record<string,string>} headers
   * @returns {boolean}
   */
  function isChunkedUpload(headers) {
    const encoding = headers["transfer-encoding"];
    if (!encoding) return false;
    return encoding.toLowerCase().includes("chunked");
  }

  /**
   * Install the file-input watcher.
   *
   * Watches for a file being chosen and, when the composer keeps it
   * client-side, attaches the cue-preserving text.
   */
  function installInputWatcher() {
    document.addEventListener(
      "change",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== "file") return;
        const file = target.files?.[0];
        if (!file) return;

        void (async () => {
          if (!isEnrichable(file.type, file.name)) return;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await enrich(bytes, file.name);
          if (!result?.marked || !result.cues?.length) {
            report("idle");
            return;
          }
          insertEnrichedText(result.marked, result.cues.length);
          report("attached", result.cues.length);
        })();
      },
      true,
    );
  }

  /**
   * Insert the cue-preserving text into the composer.
   *
   * The composer differs on every site, so this looks for a visible text
   * area near the file input and appends there. When it cannot find one, it
   * does nothing rather than corrupting the page.
   *
   * @param {string} marked
   * @param {number} cueCount
   */
  function insertEnrichedText(marked, cueCount) {
    const target = findComposerInput();
    if (!target) return;

    const note = document.createElement("div");
    note.className = "cuetap-note";
    note.setAttribute("data-cuetap-cues", String(cueCount));
    note.style.cssText = [
      "margin: 8px 0",
      "padding: 8px 10px",
      "border-left: 3px solid #0969da",
      "background: #f6f8fa",
      "font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
      "white-space: pre-wrap",
      "max-height: 180px",
      "overflow: auto",
      "border-radius: 4px",
    ].join(";");

    const header = document.createElement("strong");
    header.textContent = `CueTap — ${cueCount} cue${cueCount === 1 ? "" : "s"} recovered`;
    note.appendChild(header);
    note.appendChild(document.createTextNode("\n"));
    note.appendChild(document.createTextNode(marked));

    target.insertAdjacentElement("beforebegin", note);
  }

  /**
   * Find a plausible composer text area.
   *
   * @returns {Element|null}
   */
  function findComposerInput() {
    const selectors = ["textarea", "div[contenteditable='true']", "[role='textbox']"];
    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      // Prefer one that is visible and reasonably large.
      const visible = elements.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 100 && rect.height > 10;
      });
      if (visible) return visible;
    }
    return null;
  }

  // --- Local copies of the multipart helpers -------------------------------
  // The content script runs in the page's world and cannot import the
  // extension's modules, so the few functions it needs are inlined here.
  // They are kept behaviourally equivalent to shared/multipart.js.

  /**
   * @param {string|null|undefined} contentType
   * @returns {string|undefined}
   */
  function getBoundary(contentType) {
    if (!contentType) return undefined;
    if (!/^multipart\//i.test(contentType.trim())) return undefined;
    const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (!match) return undefined;
    return match[1] ?? match[2];
  }

  /**
   * @param {Uint8Array} body
   * @param {string} boundary
   */
  function parseMultipartLocal(body, boundary) {
    const delimiter = new TextEncoder().encode(`--${boundary}`);
    const positions = findDelimitersLocal(body, delimiter);
    if (positions.length < 2) return undefined;

    const parts = [];
    for (let i = 0; i < positions.length - 1; i += 1) {
      const start = positions[i];
      if (body[start + delimiter.length] === 0x2d && body[start + delimiter.length + 1] === 0x2d) break;

      let cursor = start + delimiter.length;
      if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2;
      else if (body[cursor] === 0x0a) cursor += 1;

      const next = positions[i + 1];
      let bodyEnd = next;
      if (bodyEnd >= 2 && body[bodyEnd - 2] === 0x0d && body[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
      else if (bodyEnd >= 1 && body[bodyEnd - 1] === 0x0a) bodyEnd -= 1;

      let headerEnd = -1;
      let bodyStart = -1;
      for (let k = cursor; k < bodyEnd - 1; k += 1) {
        if (body[k] === 0x0d && body[k + 1] === 0x0a && body[k + 2] === 0x0d && body[k + 3] === 0x0a) {
          headerEnd = k;
          bodyStart = k + 4;
          break;
        }
        if (body[k] === 0x0a && body[k + 1] === 0x0a) {
          headerEnd = k;
          bodyStart = k + 2;
          break;
        }
      }
      if (headerEnd === -1) continue;

      const headerText = new TextDecoder().decode(body.subarray(cursor, headerEnd));
      const headers = {};
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const disposition = headers["content-disposition"] ?? "";

      const name = dispositionParamLocal(disposition, "name");
      const filename = dispositionParamLocal(disposition, "filename");
      const contentType = headers["content-type"];

      parts.push({
        ...(name !== undefined ? { name } : {}),
        ...(filename !== undefined ? { filename } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
        headers,
        start: bodyStart,
        end: bodyEnd,
      });
    }
    return { boundary, parts };
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
  function findDelimitersLocal(haystack, needle) {
    const out = [];
    if (needle.length === 0) return out;

    outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }

      // The delimiter must start a line.
      if (i > 0) {
        const before = haystack[i - 1];
        if (before !== 0x0a && before !== 0x0d) continue;
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

  /**
   * @param {string} disposition
   * @param {string} parameter
   * @returns {string|undefined}
   */
  function dispositionParamLocal(disposition, parameter) {
    const quoted = new RegExp(`${parameter}\\s*=\\s*"([^"]*)"`, "i").exec(disposition);
    if (quoted) return quoted[1];
    const bare = new RegExp(`${parameter}\\s*=\\s*([^;\s]+)`, "i").exec(disposition);
    return bare?.[1];
  }

  /**
   * @param {{parts: any[]}} parsed
   */
  function findFilePartLocal(parsed) {
    const withFilename = parsed.parts.filter((part) => part.filename !== undefined);
    if (withFilename.length === 0) return undefined;
    if (withFilename.length === 1) return withFilename[0];
    const matching = withFilename.find((part) => part.filename.toLowerCase().endsWith(".docx"));
    if (matching) return matching;
    return withFilename.reduce((largest, part) =>
      part.end - part.start > largest.end - largest.start ? part : largest,
    );
  }

  /**
   * @param {Uint8Array} body
   * @param {{start:number, end:number}} part
   * @param {Uint8Array|string} replacement
   * @returns {Uint8Array}
   */
  function replacePartLocal(body, part, replacement) {
    const bytes = typeof replacement === "string" ? new TextEncoder().encode(replacement) : replacement;
    const out = new Uint8Array(body.length - (part.end - part.start) + bytes.length);
    let cursor = 0;
    out.set(body.subarray(0, part.start), cursor);
    cursor += part.start;
    out.set(bytes, cursor);
    cursor += bytes.length;
    out.set(body.subarray(part.end), cursor);
    return out;
  }

  /**
   * @param {string} base64
   * @returns {Uint8Array}
   */
  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // --- Bootstrap -----------------------------------------------------------

  void probe().then(() => {
    if (!state.active) return;
    if (state.mode === "network") {
      installFetchHook();
    }
    // A site may do both. Install the file watcher always: it is cheap and
    // only acts on a file the user actually chose.
    installInputWatcher();
  });
})();
