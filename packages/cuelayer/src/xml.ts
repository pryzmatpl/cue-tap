/**
 * A minimal, dependency-free XML reader.
 *
 * CueLayer needs to read OOXML run properties exactly: `w:highlight` and
 * `w:color` are children of `w:rPr`, and their values must be attributed to
 * the right text run. Regex over the raw XML cannot do that safely — run
 * properties nest, self-close in several dialects, and an attribute value may
 * legally contain `>`.
 *
 * This reader is deliberately narrow: it handles the subset of XML that OOXML
 * actually uses (elements, attributes, text, comments, CDATA, processing
 * instructions, entity references) and rejects anything malformed with a
 * positioned error rather than guessing.
 */

/** A parsed element node. */
export interface XmlElement {
  readonly type: "element";
  /** Tag name exactly as it appeared, including any namespace prefix. */
  readonly name: string;
  /** Local name with any namespace prefix stripped. */
  readonly localName: string;
  /** Namespace prefix, or `""` when the tag is unprefixed. */
  readonly prefix: string;
  /** Attributes keyed by their literal (prefixed) name. */
  readonly attributes: Readonly<Record<string, string>>;
  /** Child elements, in document order. */
  readonly children: readonly XmlElement[];
  /** Concatenated text content of this element, decoded. */
  readonly text: string;
  /** Text content of this element and all descendants, decoded. */
  readonly deepText: string;
}

/** A text node. */
export interface XmlText {
  readonly type: "text";
  readonly value: string;
}

/** Any node in the tree. */
export type XmlNode = XmlElement | XmlText;

/** Thrown when the XML cannot be parsed. */
export class XmlParseError extends Error {
  override readonly name = "XmlParseError";
  constructor(
    message: string,
    /** Byte-ish offset into the source where the failure occurred. */
    readonly offset: number,
  ) {
    super(`${message} (at offset ${offset})`);
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode XML entity references in a text span. */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback;
  // Lone surrogates are not valid scalar values.
  if (code >= 0xd800 && code <= 0xdfff) return fallback;
  return String.fromCodePoint(code);
}

/** A cursor-based recursive-descent XML parser. */
class XmlReader {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): XmlElement {
    this.skipProlog();
    const root = this.parseElement();
    this.skipTrailing();
    if (!root) throw new XmlParseError("document contains no root element", this.pos);
    return root;
  }

  private skipProlog(): void {
    this.skipWhitespace();
    for (;;) {
      if (this.src.startsWith("<?", this.pos)) {
        const end = this.src.indexOf("?>", this.pos + 2);
        if (end === -1) throw new XmlParseError("unterminated processing instruction", this.pos);
        this.pos = end + 2;
      } else if (this.src.startsWith("<!--", this.pos)) {
        const end = this.src.indexOf("-->", this.pos + 4);
        if (end === -1) throw new XmlParseError("unterminated comment", this.pos);
        this.pos = end + 3;
      } else if (this.src.startsWith("<!DOCTYPE", this.pos)) {
        // Skip a doctype, including a possible internal subset.
        let depth = 0;
        let i = this.pos;
        for (; i < this.src.length; i += 1) {
          const ch = this.src[i]!;
          if (ch === "[") depth += 1;
          else if (ch === "]") depth -= 1;
          else if (ch === ">" && depth <= 0) break;
        }
        if (i >= this.src.length) throw new XmlParseError("unterminated doctype", this.pos);
        this.pos = i + 1;
      } else {
        return;
      }
      this.skipWhitespace();
    }
  }

  private skipTrailing(): void {
    this.skipWhitespace();
    while (this.pos < this.src.length) {
      if (this.src.startsWith("<!--", this.pos)) {
        const end = this.src.indexOf("-->", this.pos + 4);
        if (end === -1) throw new XmlParseError("unterminated comment", this.pos);
        this.pos = end + 3;
      } else if (this.src.startsWith("<?", this.pos)) {
        const end = this.src.indexOf("?>", this.pos + 2);
        if (end === -1) throw new XmlParseError("unterminated processing instruction", this.pos);
        this.pos = end + 2;
      } else {
        throw new XmlParseError(`unexpected trailing content`, this.pos);
      }
      this.skipWhitespace();
    }
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos += 1;
  }

  private parseElement(): XmlElement | undefined {
    if (this.src[this.pos] !== "<") return undefined;
    const tagStart = this.pos;
    this.pos += 1;
    const rawName = this.readName();
    if (!rawName) throw new XmlParseError("expected element name", tagStart);

    const attributes: Record<string, string> = {};
    for (;;) {
      this.skipWhitespace();
      const ch = this.src[this.pos];
      if (ch === undefined) throw new XmlParseError("unterminated start tag", tagStart);
      if (ch === ">" || ch === "/") break;
      const attrStart = this.pos;
      const attrName = this.readName();
      if (!attrName) throw new XmlParseError("expected attribute name", attrStart);
      this.skipWhitespace();
      if (this.src[this.pos] !== "=") {
        // HTML-style bare attribute; OOXML does not use it but be lenient.
        attributes[attrName] = "";
        continue;
      }
      this.pos += 1;
      this.skipWhitespace();
      attributes[attrName] = this.readAttributeValue();
    }

    const children: XmlElement[] = [];
    let text = "";
    let deepText = "";

    if (this.src[this.pos] === "/") {
      this.pos += 1;
      if (this.src[this.pos] !== ">") throw new XmlParseError("malformed empty element", tagStart);
      this.pos += 1;
      const built = buildElement(rawName, attributes, children, text, deepText);
      return built;
    }

    this.pos += 1; // consume '>'

    for (;;) {
      if (this.pos >= this.src.length) {
        throw new XmlParseError(`unterminated element <${rawName}>`, tagStart);
      }
      if (this.src.startsWith("</", this.pos)) {
        const closeStart = this.pos;
        this.pos += 2;
        const closeName = this.readName();
        this.skipWhitespace();
        if (this.src[this.pos] !== ">") throw new XmlParseError("malformed end tag", closeStart);
        this.pos += 1;
        if (closeName !== rawName) {
          throw new XmlParseError(
            `mismatched tags: expected </${rawName}>, found </${closeName ?? "?"}>`,
            closeStart,
          );
        }
        break;
      }
      if (this.src.startsWith("<!--", this.pos)) {
        const end = this.src.indexOf("-->", this.pos + 4);
        if (end === -1) throw new XmlParseError("unterminated comment", this.pos);
        this.pos = end + 3;
        continue;
      }
      if (this.src.startsWith("<![CDATA[", this.pos)) {
        const end = this.src.indexOf("]]>", this.pos + 9);
        if (end === -1) throw new XmlParseError("unterminated CDATA section", this.pos);
        const value = this.src.slice(this.pos + 9, end);
        text += value;
        deepText += value;
        this.pos = end + 3;
        continue;
      }
      if (this.src.startsWith("<?", this.pos)) {
        const end = this.src.indexOf("?>", this.pos + 2);
        if (end === -1) throw new XmlParseError("unterminated processing instruction", this.pos);
        this.pos = end + 2;
        continue;
      }
      if (this.src[this.pos] === "<") {
        const child = this.parseElement();
        if (!child) throw new XmlParseError("malformed child element", this.pos);
        children.push(child);
        deepText += child.deepText;
        continue;
      }
      const next = this.src.indexOf("<", this.pos);
      const end = next === -1 ? this.src.length : next;
      const raw = this.src.slice(this.pos, end);
      this.pos = end;
      const decoded = decodeEntities(raw);
      text += decoded;
      deepText += decoded;
    }

    return buildElement(rawName, attributes, children, text, deepText);
  }

  private readName(): string | undefined {
    const start = this.pos;
    let i = this.pos;
    while (i < this.src.length) {
      const ch = this.src[i]!;
      if (/[A-Za-z0-9_.:\-]/.test(ch)) {
        i += 1;
        continue;
      }
      break;
    }
    if (i === start) return undefined;
    this.pos = i;
    return this.src.slice(start, i);
  }

  private readAttributeValue(): string {
    const quote = this.src[this.pos];
    if (quote === '"' || quote === "'") {
      this.pos += 1;
      const end = this.src.indexOf(quote, this.pos);
      if (end === -1) throw new XmlParseError("unterminated attribute value", this.pos);
      const raw = this.src.slice(this.pos, end);
      this.pos = end + 1;
      return decodeEntities(raw);
    }
    // Unquoted attribute value (rare in OOXML, but legal XML).
    const start = this.pos;
    while (this.pos < this.src.length && !/[\s/>]/.test(this.src[this.pos]!)) this.pos += 1;
    return decodeEntities(this.src.slice(start, this.pos));
  }
}

function buildElement(
  rawName: string,
  attributes: Record<string, string>,
  children: XmlElement[],
  text: string,
  deepText: string,
): XmlElement {
  const colon = rawName.indexOf(":");
  const prefix = colon === -1 ? "" : rawName.slice(0, colon);
  const localName = colon === -1 ? rawName : rawName.slice(colon + 1);
  return { type: "element", name: rawName, localName, prefix, attributes, children, text, deepText };
}

/**
 * Parse an XML document into a tree.
 *
 * @throws {XmlParseError} when the document is malformed.
 */
export function parseXml(source: string): XmlElement {
  return new XmlReader(source).parse();
}

/**
 * Find the first descendant with the given local name.
 *
 * @param element - Root to search under.
 * @param localName - Local name to match, without a namespace prefix.
 * @param namespacePrefix - When given, only elements with this prefix match.
 */
export function findChild(
  element: XmlElement,
  localName: string,
  namespacePrefix?: string,
): XmlElement | undefined {
  for (const child of element.children) {
    if (child.localName !== localName) continue;
    if (namespacePrefix !== undefined && child.prefix !== namespacePrefix) continue;
    return child;
  }
  return undefined;
}

/** Find every descendant with the given local name, in document order. */
export function findChildren(
  element: XmlElement,
  localName: string,
  namespacePrefix?: string,
): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.localName === localName && (namespacePrefix === undefined || child.prefix === namespacePrefix)) {
        out.push(child);
      }
      walk(child);
    }
  };
  walk(element);
  return out;
}

/** Read an attribute by local name, ignoring any namespace prefix. */
export function attr(element: XmlElement, localName: string): string | undefined {
  for (const [key, value] of Object.entries(element.attributes)) {
    const colon = key.indexOf(":");
    const local = colon === -1 ? key : key.slice(colon + 1);
    if (local === localName) return value;
  }
  return undefined;
}
