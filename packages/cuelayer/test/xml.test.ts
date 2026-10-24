import { describe, expect, it } from "vitest";
import { attr, decodeEntities, findChild, findChildren, parseXml, XmlParseError } from "../src/xml.js";

describe("XML reader", () => {
  it("parses a nested element tree", () => {
    const root = parseXml(`<a><b><c>text</c></b></a>`);
    expect(root.name).toBe("a");
    const b = findChild(root, "b");
    expect(b).toBeDefined();
    const c = findChild(b!, "c");
    expect(c?.text).toBe("text");
    expect(c?.deepText).toBe("text");
  });

  it("exposes the namespace prefix and local name", () => {
    const root = parseXml(`<w:document xmlns:w="urn:x"><w:p/></w:document>`);
    expect(root.prefix).toBe("w");
    expect(root.localName).toBe("document");
    expect(root.children[0]!.prefix).toBe("w");
    expect(root.children[0]!.localName).toBe("p");
  });

  it("reads attributes, including ones with namespace prefixes", () => {
    const root = parseXml(`<w:highlight w:val="yellow" plain="x"/>`);
    expect(attr(root, "val")).toBe("yellow");
    expect(attr(root, "plain")).toBe("x");
  });

  it("handles single-quoted attribute values", () => {
    const root = parseXml(`<w:highlight w:val='cyan'/>`);
    expect(attr(root, "val")).toBe("cyan");
  });

  it("handles an attribute value containing a greater-than sign", () => {
    const root = parseXml(`<w:x w:val="a > b"/>`);
    expect(attr(root, "val")).toBe("a > b");
  });

  it("decodes entity references in text", () => {
    const root = parseXml(`<a>Tom &amp; Jerry &lt;3 &#65; &#x42;</a>`);
    expect(root.text).toBe("Tom & Jerry <3 A B");
  });

  it("decodes named, decimal and hexadecimal entities", () => {
    expect(decodeEntities("&amp;")).toBe("&");
    expect(decodeEntities("&#65;")).toBe("A");
    expect(decodeEntities("&#x41;")).toBe("A");
    expect(decodeEntities("&unknown;")).toBe("&unknown;");
  });

  it("skips comments, processing instructions and the doctype", () => {
    const root = parseXml(
      `<?xml version="1.0"?><!DOCTYPE a SYSTEM "a.dtd"><!-- a comment --><a>text</a><!-- another -->`,
    );
    expect(root.localName).toBe("a");
    expect(root.text).toBe("text");
  });

  it("reads CDATA sections verbatim", () => {
    const root = parseXml(`<a><![CDATA[<not> & parsed]]></a>`);
    expect(root.text).toBe("<not> & parsed");
  });

  it("collects deep text across descendants", () => {
    const root = parseXml(`<a>one<b>two</b>three</a>`);
    expect(root.text).toBe("onethree");
    expect(root.deepText).toBe("onetwothree");
  });

  it("finds every descendant in document order", () => {
    const root = parseXml(`<a><p>1</p><b><p>2</p></b><p>3</p></a>`);
    const found = findChildren(root, "p");
    expect(found.map((el) => el.text)).toEqual(["1", "2", "3"]);
  });

  it("rejects a mismatched closing tag", () => {
    expect(() => parseXml(`<a><b></c></b></a>`)).toThrow(XmlParseError);
  });

  it("rejects an unterminated element", () => {
    expect(() => parseXml(`<a><b>text`)).toThrow(XmlParseError);
  });

  it("rejects an unterminated attribute value", () => {
    expect(() => parseXml(`<a w:val="unterminated></a>`)).toThrow(XmlParseError);
  });

  it("rejects a document with no root element", () => {
    expect(() => parseXml(`<!-- only a comment -->`)).toThrow(XmlParseError);
  });

  it("accepts a self-closing root element", () => {
    const root = parseXml(`<a/>`);
    expect(root.localName).toBe("a");
    expect(root.children).toHaveLength(0);
  });

  it("reports the offset where the failure occurred", () => {
    try {
      parseXml(`<a><b></c></b></a>`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XmlParseError);
      expect((err as XmlParseError).offset).toBeGreaterThan(0);
    }
  });
});
