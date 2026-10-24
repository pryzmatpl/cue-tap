# cuelayer

**Cue-preserving document extraction.**

Recover the authoring cues — highlight, colour — that ordinary text
conversion destroys, and hand them to whatever consumes your documents.

```sh
npm install cuelayer
```

---

## Use it as a library

```ts
import { extractCues } from "cuelayer";

const outcome = await extractCues(bytes);

if (outcome.ok) {
  console.log(outcome.text);      // plain text
  console.log(outcome.marked);    // cue-preserving representation
  console.log(outcome.cues);      // located cues, with offsets
  console.log(outcome.provenance); // what was found, kept, and dropped
}
```

The result always says what happened. A document with no cues returns
`cues: []` and `cuesFound: 0` — not an error, and not silence.

### The shape of a result

```ts
type ExtractSuccess = {
  ok: true;
  text: string;              // plain text, cue-free
  marked: string;            // cue-preserving representation
  cues: Cue[];               // located cues — the sidecar
  provenance: Provenance;    // what was found, kept, and dropped
  enriched?: Uint8Array;     // a cue-preserving DOCX, when requested
  enrichedType?: string;
};

type Cue = {
  kind: "highlight" | "colour" | "deletion" | "bold" | "italic" | "underline" | "strike";
  value?: string;            // "yellow" | "#FF0000"
  start: number;             // offset into `text`
  end: number;
  text: string;              // the marked span
};
```

---

## Use it as a CLI

```sh
cuetap extract policy.docx          # the cue-preserving text
cuetap extract policy.docx --json   # the full result
cuetap extract policy.docx --plain  # plain text only
cuetap extract policy.docx --formatting   # include bold/italic/strike
cuetap serve --port 8765            # the local parse service
```

---

## Use it as a service

```
POST http://127.0.0.1:8765/extract
Content-Type: application/octet-stream
X-CueTap-Filename: policy.docx
X-CueTap-Token: <token>

→ 200 OK
{
  "ok": true,
  "text": "…",
  "marked": "…",
  "cues": [ … ],
  "provenance": { … },
  "enriched": "<base64 DOCX>"
}
```

The service:

- binds to loopback only and rejects requests from any other peer;
- requires a bearer token;
- never logs document content — only filename, size and cue counts;
- treats "this document has no cue layer" as a normal `ok: true` result with
  zero cues, not as an error.

---

## What is recovered

| Cue | Source | Default |
|---|---|---|
| `highlight` | `<w:highlight w:val="yellow"/>` | **on** |
| `colour` | `<w:color w:val="FF0000"/>` | **on** |
| `deletion` | Tracked deletions (`w:del`) | **on** |
| `bold`, `italic`, `underline`, `strike` | Run properties | off — pass `includeFormatting: true` |

Bold, italic and strike are off by default because they are too common to
carry signal: an author who bolds every heading has not singled anything out.

The document's dominant text colour is treated as the default and never
reported as a cue, and black is never reported at all.

---

## The marked representation

Block structure uses Markdown where Markdown exists and custom tags where it
does not. The result is cheaper in tokens than a uniform custom-tag scheme,
and the tags are what carry the cues Markdown cannot express.

```
[HEADING level=1 style="Heading 1"]
Introduction
[/HEADING]
[PARAGRAPH roles="CRITICAL_WARNING"]
[HIGHLIGHT:YELLOW]The clause that matters.[/HIGHLIGHT]
[/PARAGRAPH]
```

A document with no cues produces `marked === text` — no markup, no token
bloat.

---

## Guarantees

**Every cue is located.** A recovered cue that cannot be located in the plain
text is reported in `provenance.cuesDropped` with reason `unlocatable`. The
extraction is wrong in that case, and it says so.

**A malformed cue is never a malformed document.** A cue that fails to parse
degrades to "cue absent" with a reason. The document still ingests.

**The body walk is complete.** Headers, footers, footnotes, endnotes and
comments are read, not just the body.

**Tracked changes are resolved.** Insertions are live text. Deletions are
reported as a `deletion` cue.

---

## API

| Export | Purpose |
|---|---|
| `extractCues(bytes, options?)` | The main entry point. |
| `detectFormat(bytes)` | Identify a document by content, not by name. |
| `buildEnrichedDocx(options)` | Write a cue-preserving DOCX. |
| `renderMarked(blocks)` | Render blocks into the cue-preserving representation. |
| `parseXml(source)` | The XML reader, if you need it. |
| `startService(options?)` | Start the local parse service. |

### Options

| Option | Default | Meaning |
|---|---|---|
| `includeFormatting` | `false` | Also emit bold/italic/underline/strike. |
| `inferDefaultColour` | `true` | Never report the dominant text colour as a cue. |
| `maxParts` | `512` | Cap on the package parts walked. |
| `buildEnriched` | `false` | Build a cue-preserving copy of the document. |

---

## Licence

MIT.
