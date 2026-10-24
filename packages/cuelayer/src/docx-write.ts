/**
 * Writing a cue-preserving DOCX.
 *
 * A composer that receives a document expects a document. Replacing the
 * uploaded DOCX with a text rendering of it would corrupt the upload, so
 * CueTap writes a real DOCX that carries the cue layer.
 *
 * How the cue layer survives the round trip:
 *
 * - The **highlight** cue is written back as a Word highlight, so a human
 *   opening the file sees exactly what the author intended.
 * - The **colour** cue is written back as a run colour.
 * - The **marked text** — the cue-preserving representation — is what the
 *   document's body contains, so a model reading the file's text sees the
 *   cue markers rather than losing them.
 *
 * The third point is the one that matters for the product: the model is the
 * consumer, and the model's view of a DOCX is its extracted text.
 */

import JSZip from "jszip";
import { escapeXml } from "./xml-text.js";
import type { Cue } from "./types.js";

/** Options for building an enriched document. */
export interface BuildDocxOptions {
  /** The original document bytes. */
  readonly original: Uint8Array;
  /** The cue-preserving text to append. */
  readonly marked: string;
  /** The cues that were recovered. */
  readonly cues: readonly Cue[];
}

/** The namespace declarations every WordprocessingML part carries. */
const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
].join(" ");

/**
 * Build a DOCX that carries the cue layer.
 *
 * The original document is preserved intact and an enriched rendition is
 * added alongside it, so nothing the author wrote is lost.
 */
/**
 * Build a DOCX that carries the cue layer.
 *
 * The document's *visible* body becomes the cue-preserving rendition: the
 * highlighted spans are written back as Word formatting, and the
 * cue-preserving text — the form a model reads — is what the document
 * contains.
 *
 * The original `word/document.xml` is preserved alongside it as
 * `word/cuetap-original.xml`, so nothing the author wrote is lost.
 */
export async function buildEnrichedDocx(options: BuildDocxOptions): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(options.original);

  // Keep the author's original body before it is replaced.
  const originalBody = zip.file("word/document.xml");
  if (originalBody) {
    const originalXml = await originalBody.async("string");
    zip.file("word/cuetap-original.xml", originalXml);
  }

  // The main document now carries the cue-preserving rendition.
  zip.file(
    "word/document.xml",
    buildEnrichedDocumentXml(options.marked, options.cues),
  );

  // Record the cue layer in the document's custom properties so that a
  // consumer that understands CueTap can read the sidecar without parsing.
  zip.file("docProps/cuetap.xml", buildCueProps(options.cues));

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Build the WordprocessingML for the enriched rendition.
 *
 * The marked text is parsed for cue markers and each marked span is written
 * as a run with the matching Word formatting, so the file both reads
 * correctly and renders the cues visually.
 */
export function buildEnrichedDocumentXml(marked: string, cues: readonly Cue[]): string {
  const body = markedToParagraphs(marked, cues);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NAMESPACES}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
}

/** Build the custom-properties part carrying the cue sidecar. */
export function buildCueProps(cues: readonly Cue[]): string {
  const entries = cues
    .map((cue) => {
      const kind = escapeXml(cue.kind);
      const value = cue.value ? escapeXml(cue.value) : "";
      const start = String(cue.start);
      const end = String(cue.end);
      return `<cue kind="${kind}" value="${value}" start="${start}" end="${end}"/>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cuetap:properties xmlns:cuetap="https://github.com/pryzmatpl/cue-tap/cuetap" version="1" count="${cues.length}">${entries}</cuetap:properties>`;
}

/** The marker syntax the marked representation uses. */
const MARKER = /\[(HIGHLIGHT|COLOR):([^\]]+)\]|\[\/(HIGHLIGHT|COLOR)\]/g;

/** A block tag in the marked representation. */
const BLOCK_TAG = /^\[(HEADING|PARAGRAPH)\b([^\]]*)\]$/;

/**
 * Convert the marked representation into WordprocessingML paragraphs.
 *
 * Block tags become real Word paragraph properties, and cue markers become
 * real Word formatting. The enriched document therefore renders the author's
 * emphasis and extracts to text that carries the markers.
 *
 * @param marked - The cue-preserving representation.
 * @param cues - The recovered cues, for the sidecar.
 */
export function markedToParagraphs(marked: string, cues: readonly Cue[]): string {
  const blocks = splitBlocks(marked);
  const out: string[] = [];

  for (const block of blocks) {
    const runs = markedParagraphToRuns(block.text, cues);
    if (!runs) continue;
    out.push(`<w:p>${block.paragraphProperties}${runs}</w:p>`);
  }

  return out.join("");
}

/** A block of the marked representation, with its structure resolved. */
interface MarkedBlock {
  /** The block's text, without any block tags. */
  text: string;
  /** The paragraph properties to write. */
  paragraphProperties: string;
}

/**
 * Split the marked representation into blocks, resolving block tags.
 *
 * A block tag and its content can be separated by blank lines — the marked
 * representation puts the tag on its own line — so the structure is
 * resolved before the content is split into paragraphs.
 *
 * @param marked - The cue-preserving representation.
 */
function splitBlocks(marked: string): MarkedBlock[] {
  const chunks = marked.split(/\n{2,}/);
  const out: MarkedBlock[] = [];

  /** The block currently being read, when a tag opened one. */
  let open: { kind: string; attributes: string; lines: string[] } | undefined;

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const openMatch = BLOCK_TAG.exec(trimmed);
    if (openMatch) {
      // A tag that opens a block: start collecting its content.
      open = { kind: openMatch[1]!, attributes: openMatch[2] ?? "", lines: [] };
      const rest = trimmed.slice(openMatch[0].length).trim();
      if (rest) open.lines.push(rest);
      continue;
    }

    const closeMatch = /^\[\/(HEADING|PARAGRAPH)\]$/.exec(trimmed);
    if (closeMatch && open) {
      out.push(buildBlock(open.kind, open.attributes, open.lines));
      open = undefined;
      continue;
    }

    if (open) {
      open.lines.push(trimmed);
      continue;
    }

    out.push({ text: trimmed, paragraphProperties: "" });
  }

  // An unterminated block still contributes its content.
  if (open) {
    out.push(buildBlock(open.kind, open.attributes, open.lines));
  }

  return out;
}

/**
 * Build a block from an open tag and its content.
 *
 * @param kind - `HEADING` or `PARAGRAPH`.
 * @param attributes - The tag's attribute string.
 * @param lines - The block's content lines.
 */
function buildBlock(kind: string, attributes: string, lines: string[]): MarkedBlock {
  const levelMatch = /level\s*=\s*(\d+)/.exec(attributes);
  const styleMatch = /style\s*=\s*"([^"]*)"/.exec(attributes);
  const text = lines.join("\n\n").trim();

  if (kind === "HEADING") {
    const level = levelMatch ? Number.parseInt(levelMatch[1]!, 10) : 1;
    const style = styleMatch ? styleMatch[1]! : `Heading ${level}`;
    return {
      text,
      paragraphProperties: `<w:pPr><w:pStyle w:val="${escapeXml(style)}"/><w:outlineLvl w:val="${Math.max(0, level - 1)}"/></w:pPr>`,
    };
  }

  // A PARAGRAPH tag carries attributes but no structural change.
  const style = styleMatch ? styleMatch[1]! : undefined;
  return {
    text,
    paragraphProperties: style ? `<w:pPr><w:pStyle w:val="${escapeXml(style)}"/></w:pPr>` : "",
  };
}

/**
 * Convert one marked paragraph into runs.
 *
 * A cue marker becomes **literal text** in the document, and the text it
 * wraps carries the matching Word formatting. Both are needed:
 *
 * - The literal marker is what a model sees when it reads the document's
 *   extracted text. Without it, the cue is lost the moment the text is
 *   flattened — which is the whole problem CueTap exists to solve.
 * - The Word formatting is what a human sees when they open the file.
 *
 * Emitting only the formatting would recreate the original bug. Emitting only
 * the literal would produce a document that no longer looks like the author's.
 */
function markedParagraphToRuns(paragraph: string, cues: readonly Cue[]): string {
  const pieces: string[] = [];
  let cursor = 0;
  let highlight: string | undefined;
  let colour: string | undefined;

  MARKER.lastIndex = 0;
  let match = MARKER.exec(paragraph);

  while (match !== null) {
    const [full, openKind, openValue, closeKind] = match;
    const start = match.index;
    const end = start + full.length;

    if (start > cursor) {
      pieces.push(runXml(paragraph.slice(cursor, start), highlight, colour));
    }

    if (openKind) {
      if (openKind === "HIGHLIGHT") {
        highlight = openValue ? openValue.toLowerCase() : undefined;
        // The marker stays in the text so the cue survives extraction.
        pieces.push(runXml(full, highlight, colour));
      } else {
        colour = openValue ? normaliseWordColour(openValue) : undefined;
        pieces.push(runXml(full, highlight, colour));
      }
      cursor = end;
    } else if (closeKind) {
      pieces.push(runXml(full, highlight, colour));
      if (closeKind === "HIGHLIGHT") highlight = undefined;
      else colour = undefined;
      cursor = end;
    }

    match = MARKER.exec(paragraph);
  }

  if (cursor < paragraph.length) {
    pieces.push(runXml(paragraph.slice(cursor), highlight, colour));
  }

  if (pieces.length === 0) pieces.push(runXml(paragraph, undefined, undefined));
  return pieces.join("");
}

/** Build one run. */
function runXml(text: string, highlight: string | undefined, colour: string | undefined): string {
  if (!text) return "";
  const rPr: string[] = [];
  if (highlight) rPr.push(`<w:highlight w:val="${escapeXml(highlight)}"/>`);
  if (colour) rPr.push(`<w:color w:val="${escapeXml(colour.replace(/^#/, ""))}"/>`);
  const rPrXml = rPr.length > 0 ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
  return `<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/**
 * Normalise a colour into a value Word accepts.
 *
 * Word uses `auto` for the default colour; a literal `#RRGGBB` is not a
 * legal `w:color` value.
 */
function normaliseWordColour(value: string): string | undefined {
  const trimmed = value.trim().toUpperCase();
  if (!trimmed || trimmed === "AUTO") return undefined;
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9A-F]{6}$/.test(hex)) return hex;
  return undefined;
}
