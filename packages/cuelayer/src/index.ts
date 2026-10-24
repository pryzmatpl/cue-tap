/**
 * The public extraction API.
 *
 * One entry point, `extractCues`, handles every supported format and never
 * throws for a document-level problem: it returns a result that states
 * exactly what was found and what was lost.
 */

import { extractDocx, DocxParseError, stripCueMarkers } from "./docx.js";
import { buildEnrichedDocx } from "./docx-write.js";
import { renderMarked, type MarkedBlock } from "./marked.js";
import type {
  Cue,
  DroppedCue,
  ExtractOptions,
  ExtractOutcome,
  ExtractResult,
  Provenance,
} from "./types.js";

export * from "./types.js";
export { extractDocx } from "./docx.js";
export { buildEnrichedDocx, buildEnrichedDocumentXml, markedToParagraphs } from "./docx-write.js";
export { renderMarked, applyCues, DEFAULT_CUE_KINDS, SALIENT_ROLES } from "./marked.js";
export { parseXml, XmlParseError } from "./xml.js";

/** Formats CueLayer can extract cues from. */
export type CueFormat = "docx" | "pdf" | "text";

/**
 * Detect the format of a document from its bytes.
 *
 * Detection is by content, not by the file name or a client-supplied MIME
 * type: an `.exe` renamed to `.docx` must not reach the DOCX parser.
 */
export function detectFormat(bytes: Uint8Array): CueFormat | "unknown" {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // A ZIP container. DOCX is the only cue-bearing format we open.
    if (looksLikeDocx(bytes)) return "docx";
    return "unknown";
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50) {
    // "%PDF-"
    return "pdf";
  }
  if (isProbablyText(bytes)) return "text";
  return "unknown";
}

/**
 * Whether a ZIP container holds a WordprocessingML package.
 *
 * Checks for the entries that make a DOCX a DOCX, without fully reading the
 * archive: `word/document.xml` plus the content-type part.
 */
function looksLikeDocx(bytes: Uint8Array): boolean {
  // Look for the literal entry names in the raw bytes. ZIP stores entry names
  // uncompressed in the local file headers, so this is a reliable and cheap
  // pre-check before handing the archive to the real parser.
  const haystack = latin1(bytes.subarray(0, Math.min(bytes.length, 65536)));
  return haystack.includes("word/document.xml") || haystack.includes("[Content_Types].xml");
}

/** Heuristic: does this look like UTF-8 text? */
function isProbablyText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return sample.length === 0 || control / sample.length < 0.02;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

/**
 * Extract authoring cues from a document.
 *
 * The returned result always states what happened. A document with no cues
 * returns `cues: []` and `cuesFound: 0` — not an error, and not silence.
 *
 * @param bytes - The raw document bytes.
 * @param options - Extraction options.
 */
export async function extractCues(
  bytes: Uint8Array,
  options: ExtractOptions = {},
): Promise<ExtractOutcome> {
  const format = detectFormat(bytes);

  if (format === "docx") {
    return extractDocxOutcome(bytes, options);
  }

  if (format === "pdf") {
    return {
      ok: false,
      reason: "unsupported_format",
      detail:
        "PDF cue recovery requires geometric analysis of filled rectangles against character bounding boxes. It is not implemented in this release; the document is passed through unmodified.",
    };
  }

  if (format === "text") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      ok: true,
      text: text.trim(),
      marked: text.trim(),
      cues: [],
      provenance: {
        cuesFound: 0,
        cuesPreserved: 0,
        cuesDropped: [],
        parts: [],
        truncated: false,
        format: "text",
      },
    };
  }

  return {
    ok: false,
    reason: "unsupported_format",
    detail: "the document is not a DOCX, PDF or plain-text file",
  };
}

/** DOCX path with the outcome shape applied. */
async function extractDocxOutcome(
  bytes: Uint8Array,
  options: ExtractOptions,
): Promise<ExtractOutcome> {
  try {
    const extraction = await extractDocx(bytes, options);
    const cues = applyDefaultColourFilter(extraction.cues, options);
    const dropped = [...extraction.dropped];

    const provenance: Provenance = {
      cuesFound: extraction.cues.length,
      cuesPreserved: cues.length,
      cuesDropped: dropped,
      parts: extraction.parts,
      truncated: extraction.truncated,
      format: "docx",
    };

    const blocks: MarkedBlock[] = extraction.blocks.map((block) => ({
      ...(block.style !== undefined ? { style: block.style } : {}),
      ...(block.heading !== undefined ? { heading: block.heading } : {}),
      ...(block.tableCell !== undefined ? { tableCell: block.tableCell } : {}),
      text: block.text,
      cues: block.cues,
    }));

    const result: ExtractResult = {
      text: extraction.text,
      marked: renderMarked(blocks),
      cues: stripCueMarkersFromCues(cues),
      provenance,
    };

    assertCuesLocated(result, dropped);

    // Build the enriched document only when there is something to carry. A
    // document with no cues must round-trip byte-identically.
    if (options.buildEnriched && cues.length > 0) {
      try {
        const enriched = await buildEnrichedDocx({
          original: bytes,
          marked: result.marked,
          cues,
        });
        return {
          ok: true,
          ...result,
          enriched,
          enrichedType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        };
      } catch (err) {
        dropped.push({
          reason: "parse_error",
          detail: `could not build the enriched document: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof DocxParseError) {
      return {
        ok: false,
        reason: err.message.includes("word/document.xml") ? "no_text_layer" : "malformed_document",
        detail: err.message,
      };
    }
    return {
      ok: false,
      reason: "malformed_document",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Drop colour cues that merely restate the document's default text colour.
 *
 * Without this, every run in a black-on-white document would be reported as
 * coloured, and the cue layer would be pure noise.
 */
function applyDefaultColourFilter(cues: readonly Cue[], options: ExtractOptions): Cue[] {
  if (options.inferDefaultColour === false) return [...cues];

  const colourCounts = new Map<string, number>();
  for (const cue of cues) {
    if (cue.kind !== "colour" || !cue.value) continue;
    colourCounts.set(cue.value, (colourCounts.get(cue.value) ?? 0) + 1);
  }
  if (colourCounts.size === 0) return [...cues];

  // The most common colour is the document's default.
  let dominant = "";
  let dominantCount = -1;
  for (const [colour, count] of colourCounts) {
    if (count > dominantCount) {
      dominant = colour;
      dominantCount = count;
    }
  }

  return cues.filter((cue) => {
    if (cue.kind !== "colour" || !cue.value) return true;
    // Black is the near-universal default text colour; never report it.
    if (cue.value === "#000000") return false;
    return cue.value !== dominant || dominantCount <= 1;
  });
}

/**
 * Remove CueTap's own cue markers from each cue's text.
 *
 * A document CueTap enriched carries its markers as literal text. When it is
 * read again, those markers are CueTap's annotations rather than the
 * author's words.
 */
function stripCueMarkersFromCues(cues: readonly Cue[]): Cue[] {
  return cues.map((cue) => {
    const stripped = stripCueMarkers(cue.text);
    if (stripped === cue.text) return cue;
    return { ...cue, text: stripped };
  });
}

/**
 * The honesty assertion: a recovered cue implies a located span.
 *
 * If a cue exists but cannot be located in the plain text, the extraction is
 * wrong. That is a defect, not a degraded outcome — it is recorded loudly in
 * provenance rather than being silently swallowed.
 */
function assertCuesLocated(result: ExtractResult, dropped: DroppedCue[]): void {
  for (const cue of result.cues) {
    if (cue.start < 0 || cue.end > result.text.length || cue.start >= cue.end) {
      dropped.push({
        reason: "unlocatable",
        detail: `${cue.kind} cue at ${cue.start}..${cue.end} does not locate inside a ${result.text.length}-character text`,
      });
    }
  }
}
