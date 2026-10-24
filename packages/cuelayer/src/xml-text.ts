/**
 * XML text escaping.
 *
 * Kept separate from the reader so that the writer does not pull in the
 * parser.
 */

/** Escape text for XML content. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
