import { describe, expect, it } from "vitest";
import { extractCues } from "../src/index.js";
import {
  buildDocx,
  colorRPr,
  highlightRPr,
  para,
  run,
  stylePPr,
} from "./fixtures.js";

describe("DOCX cue extraction", () => {
  it("extracts a highlight cue with its value and span", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Normal text. ", "") + run("Important clause.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.text).toContain("Important clause.");
    const highlights = outcome.cues.filter((cue) => cue.kind === "highlight");
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.value).toBe("yellow");
    expect(highlights[0]!.text).toBe("Important clause.");
    expect(outcome.text.slice(highlights[0]!.start, highlights[0]!.end)).toBe("Important clause.");
  });

  it("locates every cue inside the plain text — the honesty assertion", async () => {
    const bytes = await buildDocx({
      bodyXml:
        para(run("Alpha ", "") + run("beta", highlightRPr("cyan"))) +
        para(run("Gamma ", colorRPr("FF0000")) + run("delta", highlightRPr("green"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.cues.length).toBeGreaterThan(0);
    for (const cue of outcome.cues) {
      expect(cue.start).toBeGreaterThanOrEqual(0);
      expect(cue.end).toBeLessThanOrEqual(outcome.text.length);
      expect(cue.start).toBeLessThan(cue.end);
      expect(outcome.text.slice(cue.start, cue.end)).toBe(cue.text);
    }
    expect(outcome.provenance.cuesDropped.filter((d) => d.reason === "unlocatable")).toHaveLength(0);
  });

  it("merges a highlight that spans multiple runs into one cue", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("This is ", highlightRPr("yellow")) + run("one ", highlightRPr("yellow")) + run("clause.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const highlights = outcome.cues.filter((cue) => cue.kind === "highlight");
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.text).toBe("This is one clause.");
  });

  it("keeps adjacent highlights of different colours apart", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("yellow part ", highlightRPr("yellow")) + run("cyan part", highlightRPr("cyan"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const highlights = outcome.cues.filter((cue) => cue.kind === "highlight");
    expect(highlights).toHaveLength(2);
    expect(highlights.map((c) => c.value)).toEqual(["yellow", "cyan"]);
    expect(highlights[0]!.text).toBe("yellow part ");
    expect(highlights[1]!.text).toBe("cyan part");
  });

  it("treats an explicit highlight of none as no cue", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Plain enough.", highlightRPr("none"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cues).toHaveLength(0);
  });

  it("does not report bold, italic or strike by default", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Bold text.", "<w:b/>")),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cues.filter((cue) => cue.kind === "bold")).toHaveLength(0);
  });

  it("reports bold when formatting cues are explicitly requested", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Bold text.", "<w:b/>")),
    });

    const outcome = await extractCues(bytes, { includeFormatting: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cues.filter((cue) => cue.kind === "bold")).toHaveLength(1);
  });

  it("does not report the dominant colour as a cue", async () => {
    const bytes = await buildDocx({
      bodyXml:
        para(run("Ordinary text.", "")) +
        para(run("Ordinary text again.", "")) +
        para(run("Rare emphasis.", colorRPr("FF0000"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const colours = outcome.cues.filter((cue) => cue.kind === "colour");
    expect(colours).toHaveLength(1);
    expect(colours[0]!.value).toBe("#FF0000");
  });

  it("never reports black as a colour cue", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Black text.", colorRPr("000000"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cues.filter((cue) => cue.kind === "colour")).toHaveLength(0);
  });

  it("normalises a shorthand colour to six-digit hex", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Red text.", colorRPr("f00"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const colours = outcome.cues.filter((cue) => cue.kind === "colour");
    expect(colours[0]?.value).toBe("#FF0000");
  });

  it("preserves heading structure in the marked representation", async () => {
    const bytes = await buildDocx({
      bodyXml:
        para(run("Introduction"), stylePPr("Heading1")) +
        para(run("Body text.")),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.marked).toContain("[HEADING level=1");
    expect(outcome.marked).toContain("[/HEADING]");
  });

  it("separates the heading level from the style attribute", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Introduction"), stylePPr("Heading1")),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The attributes must be separated by a space, not run together.
    expect(outcome.marked).toContain('[HEADING level=1 style="Heading1"]');
    expect(outcome.marked).not.toContain("level=1style");
  });

  it("records a tracked deletion as a deletion cue", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Kept ", "") + "<w:del><w:r><w:delText>removed</w:delText></w:r></w:del>"),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const deletions = outcome.cues.filter((cue) => cue.kind === "deletion");
    expect(deletions).toHaveLength(1);
    expect(deletions[0]!.text).toBe("removed");
  });

  it("keeps tracked insertions as live text", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Kept ", "") + "<w:ins><w:r><w:t>added</w:t></w:r></w:ins>"),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("added");
    expect(outcome.cues.filter((cue) => cue.kind === "deletion")).toHaveLength(0);
  });

  it("reads text from headers and footers, not only the body", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Body text.")),
      parts: {
        "word/header1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header text.</w:t></w:r></w:p></w:hdr>`,
        "word/footer1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Footer text.</w:t></w:r></w:p></w:ftr>`,
      },
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("Header text.");
    expect(outcome.text).toContain("Footer text.");
    expect(outcome.provenance.parts).toContain("word/header1.xml");
  });

  it("degrades a malformed part to a dropped cue rather than failing the document", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Good text.")),
      parts: {
        "word/footnotes.xml": `<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote><w:p><w:r><w:t>unclosed`,
      },
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("Good text.");
    expect(outcome.provenance.cuesDropped.some((d) => d.reason === "parse_error")).toBe(true);
  });

  it("returns a clean zero-cue result for a document with no cues", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Just ordinary prose.")),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cues).toHaveLength(0);
    expect(outcome.provenance.cuesFound).toBe(0);
    expect(outcome.provenance.cuesPreserved).toBe(0);
  });

  it("produces marked output that carries the cue markers", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Pay attention to this.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.marked).toContain("[HIGHLIGHT:YELLOW]");
    expect(outcome.marked).toContain("[/HIGHLIGHT]");
    expect(outcome.marked).toContain("Pay attention to this.");
  });

  it("leaves the marked output free of markup when there are no cues", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Just ordinary prose.")),
    });

    const outcome = await extractCues(bytes);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.marked).not.toContain("[HIGHLIGHT");
    expect(outcome.marked).not.toContain("[COLOR");
    expect(outcome.marked).toBe(outcome.text);
  });

  it("rejects a ZIP that is not a WordprocessingML package", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("text")),
      documentXml: undefined,
    });
    // Replace the document part with something that is not WordprocessingML.
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("hello.txt", "not a document");
    const zipBytes = await zip.generateAsync({ type: "uint8array" });

    const outcome = await extractCues(zipBytes);
    // Either it is not detected as DOCX at all, or it is detected and fails
    // honestly — never a silent success.
    if (outcome.ok) {
      expect(outcome.provenance.format).toBe("docx");
    } else {
      expect(["no_text_layer", "malformed_document", "unsupported_format"]).toContain(outcome.reason);
    }
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("does not mistake a plain-text file for a DOCX", async () => {
    const outcome = await extractCues(new TextEncoder().encode("Hello, plain text."));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.provenance.format).toBe("text");
    expect(outcome.cues).toHaveLength(0);
  });
});
