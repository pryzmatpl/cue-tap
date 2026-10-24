import { describe, expect, it } from "vitest";
import { buildEnrichedDocx, markedToParagraphs } from "../src/docx-write.js";
import { extractCues } from "../src/index.js";
import { buildDocx, highlightRPr, para, run } from "./fixtures.js";

describe("enriched DOCX writing", () => {
  it("writes a document that carries the highlight as Word formatting", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Pay attention.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.enriched).toBeDefined();

    const roundTrip = await extractCues(outcome.enriched!);
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;

    // The cue survived the round trip.
    const highlights = roundTrip.cues.filter((cue) => cue.kind === "highlight");
    expect(highlights.length).toBeGreaterThanOrEqual(1);
    expect(highlights[0]!.value).toBe("yellow");
  });

  it("keeps the original document text intact", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Original sentence. ", "") + run("Cued.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.enriched).toBeDefined();

    const roundTrip = await extractCues(outcome.enriched!);
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.text).toContain("Original sentence.");
    expect(roundTrip.text).toContain("Cued.");
  });

  it("does not build an enriched document when there are no cues", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Nothing special here.")),
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.enriched).toBeUndefined();
  });

  it("produces valid WordprocessingML from the marked representation", () => {
    const xml = markedToParagraphs(
      "[HIGHLIGHT:YELLOW]Watch this[/HIGHLIGHT]",
      [],
    );
    expect(xml).toContain("<w:p>");
    expect(xml).toContain('<w:highlight w:val="yellow"/>');
    expect(xml).toContain("<w:t xml:space=\"preserve\">");
    expect(xml).toContain("Watch this");
  });

  it("writes a colour cue as a Word run colour", () => {
    const xml = markedToParagraphs("[COLOR:#FF0000]Red text[/COLOR]", []);
    expect(xml).toContain('<w:color w:val="FF0000"/>');
  });

  it("escapes XML metacharacters in the marked text", () => {
    const xml = markedToParagraphs("a < b & c > d", []);
    expect(xml).toContain("a &lt; b &amp; c &gt; d");
  });

  it("records the cue sidecar in the document's custom properties", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Cued.", highlightRPr("cyan"))),
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(outcome.enriched!);
    const props = await zip.file("docProps/cuetap.xml")!.async("string");
    expect(props).toContain("cuetap:properties");
    expect(props).toContain('kind="highlight"');
    expect(props).toContain('value="cyan"');
  });

  it("keeps the original package entries", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Text.", highlightRPr("yellow"))),
      parts: {
        "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="urn:cp"/>`,
      },
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(outcome.enriched!);
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(zip.file("docProps/core.xml")).not.toBeNull();
    expect(zip.file("docProps/cuetap.xml")).not.toBeNull();
  });

  it("puts the cue-preserving text in the document body", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Watch ", "") + run("this clause.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The body is what a model reads. It must carry the cue markers.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(outcome.enriched!);
    const body = await zip.file("word/document.xml")!.async("string");
    expect(body).toContain("[HIGHLIGHT:YELLOW]");
    expect(body).toContain("[/HIGHLIGHT]");
    expect(body).toContain("Watch ");
  });

  it("preserves the author's original body alongside the enriched one", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Original body.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(outcome.enriched!);
    const original = await zip.file("word/cuetap-original.xml")!.async("string");
    expect(original).toContain("Original body.");
  });

  it("writes a heading as a real Word paragraph style", () => {
    const xml = markedToParagraphs(
      '[HEADING level=2 style="Heading 2"]\n\nThe section title\n\n[/HEADING]',
      [],
    );
    expect(xml).toContain('<w:pStyle w:val="Heading 2"/>');
    expect(xml).toContain('<w:outlineLvl w:val="1"/>');
    expect(xml).toContain("The section title");
    // The block tags themselves must not appear as literal text.
    expect(xml).not.toContain("[HEADING");
    expect(xml).not.toContain("[/HEADING]");
  });

  it("round-trips a cue without accumulating markers", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Watch ", "") + run("this clause.", highlightRPr("yellow"))),
    });

    const first = await extractCues(bytes, { buildEnriched: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await extractCues(first.enriched!);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // The cue text is the author's words, not CueTap's marker text.
    const highlights = second.cues.filter((cue) => cue.kind === "highlight");
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.text).toBe("this clause.");
  });

  it("keeps the markers in the text so a model reading it sees the cues", async () => {
    const bytes = await buildDocx({
      bodyXml: para(run("Watch ", "") + run("this clause.", highlightRPr("yellow"))),
    });

    const outcome = await extractCues(bytes, { buildEnriched: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const roundTrip = await extractCues(outcome.enriched!);
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.text).toContain("[HIGHLIGHT:YELLOW]");
  });
});
