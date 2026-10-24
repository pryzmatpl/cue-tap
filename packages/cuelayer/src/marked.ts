/**
 * The cue-preserving representation.
 *
 * Two layers:
 *
 * 1. **Span markers** — Markdown where Markdown already exists (`**bold**`),
 *    custom tags where it does not (`[COLOR:#FF0000]…[/COLOR]`). A hybrid
 *    representation is meaningfully cheaper in tokens than pure custom tags,
 *    and the custom tags are what carry the cues Markdown cannot express.
 *
 * 2. **Block attributes** — style, heading level and table position are
 *    attached to the block as an attribute, not as inline markup, so that
 *    cue salience and structural facts stay independently readable.
 */

import type { Cue, CueKind, UnlocatedCue } from "./types.js";

/** A text block with its structural attributes. */
export interface MarkedBlock {
  readonly style?: string;
  readonly heading?: { readonly level: number };
  readonly tableCell?: boolean;
  readonly text: string;
  /** Cue spans relative to this block's text. */
  readonly cues: readonly UnlocatedCue[];
}

/**
 * Render blocks into the cue-preserving representation.
 *
 * @param blocks - Blocks with cues located relative to each block's text.
 */
export function renderMarked(blocks: readonly MarkedBlock[]): string {
  const out: string[] = [];

  for (const block of blocks) {
    const body = applyCues(block.text, block.cues);
    const attrs = blockAttributes(block);

    if (block.heading) {
      // The heading level comes first, so the style attribute needs a
      // leading space to separate it.
      const extra = attrs ? ` ${attrs}` : "";
      out.push(`[HEADING level=${block.heading.level}${extra}]`);
      out.push(body);
      out.push("[/HEADING]");
      continue;
    }

    if (attrs) {
      out.push(`[PARAGRAPH ${attrs}]`);
      out.push(body);
      out.push("[/PARAGRAPH]");
      continue;
    }

    out.push(body);
  }

  return out.join("\n\n");
}

/** Build the attribute string for a block, or `""` when it carries none. */
function blockAttributes(block: MarkedBlock): string {
  const parts: string[] = [];
  if (block.style) parts.push(`style="${escapeAttr(block.style)}"`);
  if (block.tableCell) parts.push("in_table=True");
  return parts.join(" ");
}

/** Escape a value for an attribute in the representation. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Apply cues to a block's text.
 *
 * Cues are applied from the end backwards so that earlier offsets stay valid
 * while the text is being rewritten.
 */
export function applyCues(text: string, cues: readonly UnlocatedCue[]): string {
  if (cues.length === 0) return text;

  const ordered = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let cursor = 0;

  for (const cue of ordered) {
    if (cue.start < cursor) continue; // Overlapping cue: the earlier one wins.
    if (cue.start >= text.length) continue;
    const end = Math.min(cue.end, text.length);
    if (end <= cue.start) continue;

    out.push(text.slice(cursor, cue.start));
    const inner = text.slice(cue.start, end);
    out.push(wrap(inner, cue));
    cursor = end;
  }
  out.push(text.slice(cursor));

  return out.join("");
}

/** Wrap a span in the marker appropriate to its cue kind. */
function wrap(inner: string, cue: UnlocatedCue): string {
  switch (cue.kind) {
    case "highlight": {
      const name = (cue.value ?? "yellow").toUpperCase();
      return `[HIGHLIGHT:${name}]${inner}[/HIGHLIGHT]`;
    }
    case "colour": {
      const value = (cue.value ?? "#000000").toUpperCase();
      return `[COLOR:${value}]${inner}[/COLOR]`;
    }
    case "deletion":
      return `~~${inner}~~`;
    case "bold":
      return `**${inner}**`;
    case "italic":
      return `*${inner}*`;
    case "underline":
      return `<u>${inner}</u>`;
    case "strike":
      return `~~${inner}~~`;
    default:
      return inner;
  }
}

/**
 * The cue vocabulary CueLayer emits by default.
 *
 * Bold, italic, underline and strike are excluded: they are too common in
 * real documents to signal intent, and emitting them measurably dilutes the
 * cues that do carry signal.
 */
export const DEFAULT_CUE_KINDS: readonly CueKind[] = ["highlight", "colour"];

/**
 * The salience-filtered role vocabulary.
 *
 * Typed roles are only useful if they are rare enough to mean something. The
 * full structural role vocabulary is mostly uninformative; only the roles
 * below survive that filter.
 */
export const SALIENT_ROLES: readonly string[] = ["CRITICAL_WARNING", "WARNING", "DEPRECATED"];
