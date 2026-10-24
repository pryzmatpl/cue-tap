/**
 * DOCX (OOXML) cue extraction.
 *
 * The document model this walks:
 *
 * ```text
 * w:document
 *   w:body
 *     w:p                      paragraph
 *       w:pPr                  paragraph properties (style)
 *         w:pStyle w:val="Heading1"
 *       w:r                    run  ── carries w:rPr (the cue state)
 *         w:rPr
 *           w:highlight w:val="yellow"
 *           w:color w:val="FF0000"
 *         w:t                   the run's text
 *       w:ins / w:del          tracked changes
 * ```
 *
 * A cue can start in one run and end in another, so spans are built by
 * attaching cue state to *character positions*, then merging adjacent
 * positions that share the same cue state. Per-run regex matching would
 * produce wrong spans at every run boundary.
 */

import JSZip from "jszip";
import { attr, findChild, findChildren, parseXml, type XmlElement } from "./xml.js";
import type { Cue, CueKind, DroppedCue, ExtractOptions, UnlocatedCue } from "./types.js";

/** A package part that contributes text to the document. */
const CONTENT_PARTS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /^word\/document\.xml$/, label: "word/document.xml" },
  { pattern: /^word\/header\d*\.xml$/, label: "header" },
  { pattern: /^word\/footer\d*\.xml$/, label: "footer" },
  { pattern: /^word\/footnotes\.xml$/, label: "word/footnotes.xml" },
  { pattern: /^word\/endnotes\.xml$/, label: "word/endnotes.xml" },
  { pattern: /^word\/comments\.xml$/, label: "word/comments.xml" },
  { pattern: /^word\/numbering\.xml$/, label: "word/numbering.xml" },
];

/** Text-bearing parts that are read for properties, not body text. */
const PROPERTY_PARTS = ["docProps/core.xml", "docProps/app.xml"] as const;

/** The OOXML highlight names that are actually renderable cues. */
const REAL_HIGHLIGHTS = new Set([
  "black",
  "blue",
  "cyan",
  "green",
  "magenta",
  "red",
  "yellow",
  "white",
  "darkBlue",
  "darkCyan",
  "darkGreen",
  "darkMagenta",
  "darkRed",
  "darkYellow",
  "darkGray",
  "lightGray",
  "none",
]);

/** Cue state carried by a run. */
interface RunCues {
  highlight?: string;
  colour?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** A block of text with its structural style and its cue map. */
interface Block {
  /** Structural style name, e.g. `"Heading 1"`. */
  style?: string;
  /** Whether the block is a heading. */
  heading?: { readonly level: number };
  /** Whether the block is a table cell. */
  tableCell?: boolean;
  /** The plain text of the block. */
  text: string;
  /** Cue spans relative to this block's text. */
  cues: BlockCue[];
}
interface BlockCue {
  kind: CueKind;
  value?: string;
  start: number;
  end: number;
}
/** Outcome of a DOCX extraction, before it is merged into the public result. */
export interface DocxExtraction {
  text: string;
  blocks: Block[];
  cues: Cue[];
  dropped: DroppedCue[];
  parts: string[];
  truncated: boolean;
}

/**
 * Extract cues from a DOCX package.
 *
 * Never throws for a cue-level problem: a malformed cue degrades to "cue
 * absent" with a reason in provenance, so the document still ingests.
 */
export async function extractDocx(bytes: Uint8Array, options: ExtractOptions = {}): Promise<DocxExtraction> {
  const maxParts = options.maxParts ?? 512;
  const dropped: DroppedCue[] = [];
  const parts: string[] = [];
  const allBlocks: Block[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new DocxParseError(`not a readable DOCX package: ${errorMessage(err)}`);
  }

  const contentEntries = Object.keys(zip.files)
    .filter((name) => CONTENT_PARTS.some((part) => part.pattern.test(name)))
    .filter((name) => !zip.files[name]!.dir)
    .sort((a, b) => partOrder(a) - partOrder(b) || a.localeCompare(b));

  if (contentEntries.length === 0) {
    throw new DocxParseError("DOCX package contains no word/document.xml");
  }

  const budget = Math.min(contentEntries.length, maxParts);
  let truncated = contentEntries.length > budget;

  for (const name of contentEntries.slice(0, budget)) {
    const entry = zip.files[name];
    if (!entry) continue;
    let xml: string;
    try {
      xml = await entry.async("string");
    } catch (err) {
      truncated = true;
      dropped.push({ reason: "parse_error", detail: `${name}: ${errorMessage(err)}` });
      continue;
    }
    let root: XmlElement;
    try {
      root = parseXml(xml);
    } catch (err) {
      truncated = true;
      dropped.push({ reason: "parse_error", detail: `${name}: ${errorMessage(err)}` });
      continue;
    }
    try {
      const blocks = parsePart(root, name, options, dropped);
      allBlocks.push(...blocks);
      parts.push(name);
    } catch (err) {
      truncated = true;
      dropped.push({ reason: "parse_error", detail: `${name}: ${errorMessage(err)}` });
    }
  }

  // Document properties can carry cue-like emphasis in titles. They are read
  // for completeness but appended as their own blocks so they never corrupt
  // the body text offsets.
  for (const name of PROPERTY_PARTS) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    try {
      const xml = await entry.async("string");
      const root = parseXml(xml);
      const blocks = parsePropertyPart(root, name);
      if (blocks.length > 0) {
        allBlocks.push(...blocks);
        parts.push(name);
      }
    } catch {
      truncated = true;
      dropped.push({ reason: "parse_error", detail: `${name}: unreadable document properties` });
    }
  }

  const { text, cues } = assemble(allBlocks, parts);
  return { text, blocks: allBlocks, cues, dropped, parts, truncated };
}

/** Thrown when a DOCX package cannot be opened at all. */
export class DocxParseError extends Error {
  override readonly name = "DocxParseError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Document order: body first, then headers, footers, notes. */
function partOrder(name: string): number {
  if (name === "word/document.xml") return 0;
  if (name.startsWith("word/header")) return 1;
  if (name.startsWith("word/footer")) return 2;
  if (name === "word/footnotes.xml") return 3;
  if (name === "word/endnotes.xml") return 4;
  if (name === "word/comments.xml") return 5;
  return 6;
}

/** Parse one content part into blocks. */
function parsePart(
  root: XmlElement,
  partName: string,
  options: ExtractOptions,
  dropped: DroppedCue[],
): Block[] {
  const blocks: Block[] = [];
  // Walk every paragraph in the part, wherever it lives. Using
  // findChildren (a full-tree walk) rather than a body-only walk is what
  // makes text boxes and nested tables reachable.
  const paragraphs = findChildren(root, "p");

  for (const paragraph of paragraphs) {
    // A paragraph nested inside another paragraph (text box) is walked twice.
    if (hasAncestorParagraph(paragraph, root)) continue;

    const pPr = findChild(paragraph, "pPr");
    const style = pPr ? attr(findChild(pPr, "pStyle") ?? pPr, "val") : undefined;
    const heading = headingInfo(style);
    const inTable = isInsideTable(paragraph, root);

    const pieces: TextPiece[] = [];
    collectParagraphRuns(paragraph, pieces, options, dropped, partName);

    if (pieces.length === 0) continue;

    const { text, cues } = mergePieces(pieces);
    if (text.length === 0) continue;

    blocks.push({
      ...(style !== undefined ? { style } : {}),
      ...(heading !== undefined ? { heading } : {}),
      ...(inTable ? { tableCell: true } : {}),
      text,
      cues,
    });
  }
  return blocks;
}

/** Parse `docProps/core.xml` / `app.xml` into blocks. */
function parsePropertyPart(root: XmlElement, partName: string): Block[] {
  const blocks: Block[] = [];
  for (const child of root.children) {
    const value = child.deepText.trim();
    if (!value) continue;
    blocks.push({ text: value, cues: [], style: `property:${child.localName}`, ...(partName ? {} : {}) });
  }
  return blocks;
}

/** A run of text with the cue state that applies to it. */
interface TextPiece {
  text: string;
  cues: RunCues;
  /** True when the text was a tracked deletion. */
  deleted?: boolean;
}

function hasAncestorParagraph(paragraph: XmlElement, root: XmlElement): boolean {
  let found = false;
  const walk = (node: XmlElement, insideParagraph: boolean): void => {
    if (found) return;
    for (const child of node.children) {
      if (child === paragraph) {
        if (insideParagraph) {
          found = true;
          return;
        }
      }
      walk(child, insideParagraph || child.localName === "p");
    }
  };
  walk(root, false);
  return found;
}

function isInsideTable(paragraph: XmlElement, root: XmlElement): boolean {
  let found = false;
  const walk = (node: XmlElement, insideTable: boolean): void => {
    if (found) return;
    for (const child of node.children) {
      if (child === paragraph) {
        if (insideTable) {
          found = true;
          return;
        }
      }
      walk(child, insideTable || child.localName === "tbl");
    }
  };
  walk(root, false);
  return found;
}

/** Heading level from a style name, when it names one. */
function headingInfo(style: string | undefined): { level: number } | undefined {
  if (!style) return undefined;
  const match = /^heading\s*(\d+)$/i.exec(style.trim());
  if (!match) return undefined;
  const level = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(level) || level < 1 || level > 9) return undefined;
  return { level };
}

/**
 * Collect the text runs of a paragraph, resolving run properties and
 * tracked changes.
 */
function collectParagraphRuns(
  paragraph: XmlElement,
  pieces: TextPiece[],
  options: ExtractOptions,
  dropped: DroppedCue[],
  partName: string,
): void {
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      switch (child.localName) {
        case "pPr":
          // Paragraph properties carry no text.
          break;
        case "r": {
          const cues = readRunCues(child, options);
          const runText = readRunText(child);
          if (runText.length > 0) pieces.push({ text: runText, cues });
          break;
        }
        case "ins": {
          // Tracked insertion: the text is live.
          const before = pieces.length;
          walk(child);
          for (let i = before; i < pieces.length; i += 1) pieces[i]!.deleted = false;
          break;
        }
        case "del": {
          // Tracked deletion: the text is gone, but we record it as a cue so
          // the reader knows a clause was struck.
          const before = pieces.length;
          walk(child);
          for (let i = before; i < pieces.length; i += 1) pieces[i]!.deleted = true;
          break;
        }
        case "delText":
          // Handled by the `del` branch above; a bare delText is ignored.
          break;
        case "hyperlink":
        case "sdt":
        case "sdtContent":
        case "smartTag":
        case "customXml":
        case "fldSimple":
        case "dir":
        case "bdo":
          walk(child);
          break;
        case "txbxContent":
        case "footnoteReference":
        case "endnoteReference":
        case "commentReference":
          break;
        default:
          // Elements that can contain runs in nested structures.
          if (child.children.length > 0) walk(child);
          break;
      }
    }
  };
  walk(paragraph);
}

/** Read the cue state from a run's `w:rPr`. */
function readRunCues(run: XmlElement, options: ExtractOptions): RunCues {
  const rPr = findChild(run, "rPr");
  const cues: RunCues = {};
  if (!rPr) return cues;

  const highlight = findChild(rPr, "highlight");
  if (highlight) {
    const value = attr(highlight, "val");
    if (value) {
      const normalized = normalizeHighlight(value);
      if (normalized && normalized !== "none") {
        cues.highlight = normalized;
      } else if (normalized === "none") {
        // An explicit `none` is the author *removing* a highlight. It is not
        // a cue and not a drop worth reporting.
      }
    }
  }

  const color = findChild(rPr, "color");
  if (color) {
    const value = attr(color, "val");
    if (value) {
      const normalized = normalizeColour(value);
      if (normalized) cues.colour = normalized;
    }
  }

  if (options.includeFormatting) {
    if (findChild(rPr, "b")) cues.bold = true;
    if (findChild(rPr, "i")) cues.italic = true;
    if (findChild(rPr, "u")) cues.underline = true;
    if (findChild(rPr, "strike")) cues.strike = true;
  }

  return cues;
}

/** Normalise an OOXML highlight value to its canonical name. */
function normalizeHighlight(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // OOXML highlight names are case-sensitive; accept common casing variants.
  for (const candidate of REAL_HIGHLIGHTS) {
    if (candidate.toLowerCase() === trimmed.toLowerCase()) return candidate;
  }
  return undefined;
}

/** Normalise an OOXML colour to `#RRGGBB`, or `undefined` for auto/default. */
export function normalizeColour(value: string): string | undefined {
  const trimmed = value.trim().toUpperCase();
  if (!trimmed || trimmed === "AUTO") return undefined;

  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  if (hex.length === 3) {
    // Shorthand hex. Not produced by Word itself, but harmless to accept.
    return `#${hex
      .split("")
      .map((ch) => ch + ch)
      .join("")}`;
  }
  if (/^[0-9A-F]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9A-F]{8}$/.test(hex)) return `#${hex.slice(0, 6)}`;
  return undefined;
}

/** Read the text of a run, handling `w:t`, `w:tab`, `w:br`, and `w:cr`. */
function readRunText(run: XmlElement): string {
  let out = "";
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      switch (child.localName) {
        case "t":
        case "delText":
          // `w:delText` carries the text of a tracked deletion. It is read
          // here so the deletion can be reported as a cue; the `w:del`
          // branch marks it as deleted.
          out += child.text;
          break;
        case "tab":
          out += "\t";
          break;
        case "br":
        case "cr":
          out += "\n";
          break;
        case "noBreakHyphen":
          out += "-";
          break;
        case "softHyphen":
          out += "";
          break;
        case "sym": {
          const code = attr(child, "char");
          if (code) {
            const parsed = Number.parseInt(code, 16);
            if (Number.isFinite(parsed) && parsed > 0) out += String.fromCodePoint(parsed);
          }
          break;
        }
        case "rPr":
          break;
        default:
          if (child.children.length > 0) walk(child);
          break;
      }
    }
  };
  walk(run);
  return out;
}

/**
 * Merge adjacent pieces that share a cue state into one span each.
 *
 * This is the step that makes spans correct across run boundaries: a
 * highlight spanning three runs becomes one cue, not three.
 */
function mergePieces(pieces: TextPiece[]): { text: string; cues: BlockCue[] } {
  let text = "";
  const cues: BlockCue[] = [];

  for (const piece of pieces) {
    const start = text.length;
    text += piece.text;
    const end = text.length;
    if (start === end) continue;

    if (piece.deleted) {
      cues.push({ kind: "deletion", value: "tracked-deletion", start, end });
      continue;
    }

    if (piece.cues.highlight) {
      cues.push({ kind: "highlight", value: piece.cues.highlight, start, end });
    }
    if (piece.cues.colour) {
      cues.push({ kind: "colour", value: piece.cues.colour, start, end });
    }
    if (piece.cues.bold) cues.push({ kind: "bold", start, end });
    if (piece.cues.italic) cues.push({ kind: "italic", start, end });
    if (piece.cues.underline) cues.push({ kind: "underline", start, end });
    if (piece.cues.strike) cues.push({ kind: "strike", start, end });
  }

  return { text, cues: coalesce(cues) };
}

/** Merge overlapping and adjacent cues of the same kind and value. */
function coalesce(cues: BlockCue[]): BlockCue[] {
  if (cues.length < 2) return cues;
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: BlockCue[] = [];
  for (const cue of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === cue.kind &&
      last.value === cue.value &&
      cue.start <= last.end
    ) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

/**
 * Assemble blocks into the final text and locate every cue in it.
 *
 * The returned cue offsets index into the final text — the contract the
 * extension and the eval harness both rely on.
 */
function assemble(blocks: Block[], parts: string[]): { text: string; cues: Cue[] } {
  const chunks: string[] = [];
  const cues: Cue[] = [];
  let offset = 0;

  for (const block of blocks) {
    const blockStart = offset;
    chunks.push(block.text);
    offset += block.text.length;

    for (const cue of block.cues) {
      cues.push({
        kind: cue.kind,
        ...(cue.value !== undefined ? { value: cue.value } : {}),
        start: blockStart + cue.start,
        end: blockStart + cue.end,
        text: block.text.slice(cue.start, cue.end),
      });
    }

    chunks.push("\n\n");
    offset += 2;
  }

  // The trailing trim can pull the text back by a couple of characters, which
  // would leave the last cues pointing past the end. Clamp rather than
  // silently drop them — the honesty assertion downstream reports anything
  // that still fails to locate.
  const text = chunks.join("").replace(/\n{3,}/g, "\n\n").trim();
  const clamped = cues.map((cue) => {
    const start = Math.min(cue.start, text.length);
    const end = Math.min(Math.max(cue.end, start), text.length);
    return { ...cue, start, end, text: text.slice(start, end) };
  });
  return { text, cues: clamped };
}

/**
 * Strip CueTap's own cue markers from a cue's text.
 *
 * A document that CueTap enriched carries its markers as literal text, so
 * that a model reading the file's text sees them. When such a document is
 * read again, the markers are CueTap's annotations rather than the author's
 * words, and the cue's span should cover the marked text alone.
 *
 * The offsets are left alone: they still index the text as it stands.
 */
export function stripCueMarkers(text: string): string {
  return text
    .replace(/^\[(HIGHLIGHT|COLOR):[^\]]*\]/, "")
    .replace(/\[\/(HIGHLIGHT|COLOR)\]$/, "");
}
