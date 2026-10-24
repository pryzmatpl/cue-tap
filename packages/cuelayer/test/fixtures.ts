/**
 * Build DOCX fixtures in memory.
 *
 * The fixtures are generated rather than committed as binaries so that the
 * expected behaviour is visible in the test source, and so that the test
 * suite has no opaque blobs a reviewer cannot inspect.
 */

import JSZip from "jszip";

/** A minimal but valid DOCX package. */
export interface DocxFixtureOptions {
  /** The body XML, already in WordprocessingML form. */
  readonly bodyXml?: string;
  /** Extra parts, keyed by path. */
  readonly parts?: Readonly<Record<string, string>>;
  /** `word/document.xml`, when it should not be the default. */
  readonly documentXml?: string;
}

/** The XML namespace declarations every WordprocessingML part carries. */
const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
].join(" ");

/**
 * Build a DOCX package.
 *
 * @param options - Fixture options.
 */
export async function buildDocx(options: DocxFixtureOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const documentXml =
    options.documentXml ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NAMESPACES}><w:body>${options.bodyXml ?? ""}</w:body></w:document>`;

  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS);

  for (const [name, content] of Object.entries(options.parts ?? {})) {
    zip.file(name, content);
  }

  const buffer = await zip.generateAsync({ type: "uint8array" });
  return buffer;
}

/** Build a run with the given properties and text. */
export function run(text: string, rPr = ""): string {
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** Build a paragraph. */
export function para(content: string, pPr = ""): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${content}</w:p>`;
}

/** Run properties for a highlight. */
export function highlightRPr(colour: string): string {
  return `<w:highlight w:val="${colour}"/>`;
}

/** Run properties for a text colour. */
export function colorRPr(colour: string): string {
  return `<w:color w:val="${colour}"/>`;
}

/** Paragraph properties naming a style. */
export function stylePPr(style: string): string {
  return `<w:pStyle w:val="${style}"/>`;
}

/** Escape text for XML content. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
