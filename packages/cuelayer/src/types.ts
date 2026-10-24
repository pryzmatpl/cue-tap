/**
 * CueLayer public contract.
 *
 * The same shape travels from the extractor to the local service to the browser
 * extension, so every consumer reads one definition of "what a cue is".
 */

/**
 * The authoring cues CueLayer recovers.
 *
 * Only `highlight` and `colour` are emitted by default. Bold / italic / strike
 * are too common in real documents to signal intent: an author who bolds every
 * heading has not singled anything out. They are collected when
 * {@link ExtractOptions.includeFormatting} is set, but never emitted by
 * default — emitting them measurably dilutes the cue layer.
 */
export type CueKind = "highlight" | "colour" | "deletion" | "bold" | "italic" | "underline" | "strike";

/** A single recovered cue, located in the plain-text layer. */
export interface Cue {
  /** Which authoring channel produced this cue. */
  readonly kind: CueKind;
  /**
   * Cue payload:
   * - `highlight` — the OOXML highlight name, e.g. `"yellow"`, `"cyan"`.
   * - `colour` — the text colour as `#RRGGBB`, normalised to uppercase hex.
   * - `deletion` — always `"tracked-deletion"`.
   * - formatting kinds — always `undefined`.
   */
  readonly value?: string;
  /** Inclusive start offset into {@link ExtractResult.text}. */
  readonly start: number;
  /** Exclusive end offset into {@link ExtractResult.text}. */
  readonly end: number;
  /** The marked span. Self-describing: it carries the cue's meaning on its own. */
  readonly text: string;
  /** Which part of the package the cue was found in, e.g. `"word/document.xml"`. */
  readonly part?: string;
}

/**
 * A cue that has not yet been located in the final text.
 *
 * Block-relative offsets; the text is filled in when the blocks are assembled
 * into the final document text.
 */
export interface UnlocatedCue {
  readonly kind: CueKind;
  readonly value?: string;
  readonly start: number;
  readonly end: number;
}

/** Why a cue was not carried into the output. */
export interface DroppedCue {
  /** Stable, machine-readable reason code. */
  readonly reason:
    | "empty_span"
    | "unlocatable"
    | "unsupported_part"
    | "parse_error"
    | "no_text_layer"
    | "colour_is_default"
    | "highlight_is_none";
  /** Human-readable detail for logs and the composer panel. */
  readonly detail?: string;
}

/** How the extraction went. Always present — a silent extraction is the bug. */
export interface Provenance {
  /** Cue-shaped features found in the source document. */
  readonly cuesFound: number;
  /** Cues successfully carried into {@link ExtractResult.marked}. */
  readonly cuesPreserved: number;
  /** Cues found but not carried, each with a reason. */
  readonly cuesDropped: readonly DroppedCue[];
  /** Package parts that contributed text, in document order. */
  readonly parts: readonly string[];
  /** True when a part was skipped because it could not be parsed. */
  readonly truncated: boolean;
  /** Detected document format. */
  readonly format: "docx" | "pdf" | "text" | "unknown";
}

/** The result of extracting one document. */
export interface ExtractResult {
  /** Plain text with no cue markup. The base layer every consumer can rely on. */
  readonly text: string;
  /**
   * Cue-preserving representation of {@link ExtractResult.text}.
   *
   * Block structure uses Markdown where Markdown exists and custom tags where
   * it does not, so the representation stays close to the token cost of the
   * original document.
   */
  readonly marked: string;
  /** Located cues, the sidecar. */
  readonly cues: readonly Cue[];
  /** How the extraction went. */
  readonly provenance: Provenance;
}

/** Options for a single extraction. */
export interface ExtractOptions {
  /**
   * Emit bold / italic / underline / strike cues in addition to highlight and
   * colour. Off by default: these cues are too common to carry signal and
   * dilute the ones that do.
   */
  readonly includeFormatting?: boolean;
  /**
   * Treat the document's body text colour as the "default" colour and never
   * emit it as a cue. Defaults to true — otherwise every run in a black-on-
   * white document would be reported as coloured.
   */
  readonly inferDefaultColour?: boolean;
  /**
   * Maximum number of package parts to walk. Guards against zip bombs and
   * pathological documents. Defaults to 512.
   */
  readonly maxParts?: number;
  /**
   * Build an enriched document that carries the cue layer.
   *
   * Off by default because it costs a full rewrite of the package. The local
   * service turns it on, because the extension needs a real document to
   * upload in place of the original.
   */
  readonly buildEnriched?: boolean;
}

/** Reason codes returned by the service for a document it cannot enrich. */
export type ExtractFailureReason =
  | "unsupported_format"
  | "no_text_layer"
  | "malformed_document"
  | "empty_document";

/** A failed extraction. `text` is best-effort so the caller can still send the file. */
export interface ExtractFailure {
  readonly ok: false;
  readonly reason: ExtractFailureReason;
  readonly detail?: string;
  /** Best-effort plain text, when it could be recovered. */
  readonly text?: string;
}

/** A successful extraction. */
export interface ExtractSuccess {
  readonly ok: true;
  readonly text: string;
  readonly marked: string;
  readonly cues: readonly Cue[];
  readonly provenance: Provenance;
  /**
   * The enriched document, when the format supports being rewritten.
   *
   * For DOCX this is a real `.docx` that carries the cue layer — the
   * highlighted spans are written back as Word formatting, and the
   * cue-preserving text is included so that a model reading the file's text
   * sees the markers. Absent when the format cannot be rewritten.
   */
  readonly enriched?: Uint8Array;
  /** The media type of {@link ExtractSuccess.enriched}. */
  readonly enrichedType?: string;
}

/** Discriminated result of an extraction. */
export type ExtractOutcome = ExtractSuccess | ExtractFailure;
