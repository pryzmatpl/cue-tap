# CueTap

**Keep the author's emphasis.**

When you write a document and highlight a clause, colour a sentence, or strike
out a paragraph, you are telling the reader what matters. Every ordinary
document converter throws that away. The model receives a wall of plain text
and has no idea which sentence you were pointing at.

CueTap recovers the cues and delivers the document with the emphasis intact.

```
┌─ your document ──────────┐        ┌─ what the model receives ───────────────┐
│                          │        │                                        │
│  Normal prose here.      │        │  Normal prose here.                     │
│                          │        │  [HIGHLIGHT:YELLOW]The clause you        │
│  The clause you want     │  ───▶  │  flagged as critical.[/HIGHLIGHT]       │
│  flagged as critical.    │        │                                        │
└──────────────────────────┘        └────────────────────────────────────────┘
```

---

## Two pieces, one implementation

| Package | What it is |
|---|---|
| [`packages/cuelayer`](packages/cuelayer) | The cue-extraction core: a library, a CLI, and a local parse service. MIT. |
| [`packages/cuetap-chrome`](packages/cuetap-chrome) | The Chrome extension (MV3) that talks to the service. MIT. |

They are separate because a browser extension **cannot** read authoring cues
from a page's `File` object — the page owns those bytes, and the cue data
lives inside the file. Something has to parse the container. That is the
service's job, and the extension's job is to hand it the bytes and put the
result back where it came from.

The library is useful on its own: anything that ingests Word documents can
preserve the cue layer with one function call.

---

## Why only two cues?

Bold, italic, underline and strikethrough are **too common to carry signal**.
An author who bolds every heading has not singled anything out. Highlight and
colour are rare enough to mean something.

So CueLayer emits exactly two cues by default. The others are parsed when you
ask for them (`includeFormatting: true`), but they are off by default because
emitting them measurably dilutes the cues that do carry signal.

---

## Quick start

```sh
git clone https://github.com/pryzmatpl/cue-tap.git
cd cue-tap
npm install
npm run verify        # typecheck, test, build
```

### Extract a document

```sh
npx cuelayer extract policy.docx          # the cue-preserving text
npx cuelayer extract policy.docx --json   # text, marked, cues, provenance
npx cuelayer extract policy.docx --plain  # plain text only
```

### Run the local service

```sh
npx cuelayer serve --port 8765
```

```
cuelayer service listening on http://127.0.0.1:8765
  POST /extract   (application/octet-stream)
  GET  /health    (version + protocol)
  GET  /version
```

### Install the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select `packages/cuetap-chrome`.
4. Start the service (`npx cuelayer serve`) and open the CueTap popup.

The popup shows whether the service is reachable and which sites are supported.

---

## What the extension does, precisely

**Mode A — network.** On a composer that posts the file bytes over HTTP,
CueTap intercepts the upload request, extracts the file part, asks the local
service for a cue-preserving version of the document, and splices it back in.
Every other part of the request — conversation context, images, other files —
is preserved **byte-for-byte**. `Content-Length` is corrected.

**Mode B — client-side.** On a composer that reads the file in the browser and
never posts the raw bytes, no plugin can rewrite the upload. CueTap attaches
the cue-preserving text alongside the file instead, and says so.

**Unsupported sites.** CueTap only acts on sites listed in
[`sites.json`](packages/cuetap-chrome/sites.json), and only when the site's
upload mechanism has actually been observed. On anything else it stays inert.
An honest "not supported here" is better than a silent cue loss.

---

## Trust and privacy

This is not a feature list. It is the reason the project is worth publishing.

- **Everything runs on your machine.** The service binds to `127.0.0.1` and
  rejects requests from any other peer.
- **No telemetry.** No analytics, no crash reporting, no remote configuration.
  The extension works fully offline.
- **Document content is never logged.** The service logs the filename, size
  and cue counts — never the content. A user's document is not telemetry.
- **Minimal permissions.** No `<all_urls>`, no `webRequest`, no `cookies`, no
  `history`, no `downloads`, no `debugger`. Host permissions cover only the
  loopback service; the extension script is injected per site.
- **A per-install token.** The service requires a bearer token that is
  generated locally and never leaves the machine.
- **You can see what the model will receive.** The popup lists every
  recovered cue.

The extension sees every upload you make. That is a credential-adjacent
position — contracts, NDAs, HR paperwork, medical records. The design above is
the price of admitting that the useful thing is to see inside the upload.

---

## How it works

### The extraction core

A `.docx` is a ZIP of XML. The cue layer lives in the run properties of
`word/document.xml`:

```xml
<w:r>
  <w:rPr>
    <w:highlight w:val="yellow"/>
    <w:color w:val="FF0000"/>
  </w:rPr>
  <w:t>The clause you flagged.</w:t>
</w:r>
```

CueLayer walks the package with its own XML reader — not a regex — and builds
a **character-offset map** while walking runs. A highlight that starts in one
run and ends in another becomes **one** cue, not three, because cue state is
attached to character positions rather than to runs.

It also handles the things that quietly break parsers:

- **Headers, footers, footnotes, endnotes and comments** are all read, not
  just the body. A body-only walk misses real content.
- **Tracked changes** are resolved: insertions are live text, deletions are
  reported as a `deletion` cue so the reader knows a clause was struck.
- **Vertical-merge tables** are read cell-by-cell, never reconstructed from
  the table grid.
- **A malformed cue degrades to "cue absent"**, never to "document
  unreadable". Every extraction says what it found and what it dropped, and
  why.

### The honesty assertion

> *A recovered cue implies a located span.*

If a cue is found but cannot be located in the plain text, the extraction is
wrong. That is reported loudly in provenance rather than swallowed. This is
the assertion that keeps a silent failure from becoming a silent success.

### Zero-cue regression

A document with no cues must ingest **identically** to today: no markup, no
token bloat, no changed output. There is a test for exactly that, because it
is the property that protects everyone who is not using this.

---

## Repository layout

```
cue-tap/
├── packages/
│   ├── cuelayer/            the core library, CLI and service
│   │   ├── src/
│   │   │   ├── docx.ts      OOXML cue extraction
│   │   │   ├── docx-write.ts  writing a cue-preserving DOCX
│   │   │   ├── xml.ts       a small, strict XML reader
│   │   │   ├── marked.ts    the cue-preserving representation
│   │   │   ├── service.ts   the loopback HTTP service
│   │   │   └── cli.ts       the `cuetap` command
│   │   └── test/
│   └── cuetap-chrome/       the Chrome MV3 extension
│       ├── manifest.json
│       ├── background.js    the service worker
│       ├── content/         the page-world interceptor
│       ├── shared/          multipart parsing, site manifest
│       └── popup/           the panel
├── LICENSE
└── README.md
```

---

## Development

```sh
npm install
npm run typecheck    # types across both packages
npm run test         # 66 tests
npm run build        # build the library
npm run lint         # syntax check the extension
npm run verify       # all of the above
```

The extension ships as plain JavaScript with JSDoc types — Chrome runs no
build step, so neither does CueTap. The library is TypeScript and compiles to
ESM.

---

## Status

| | |
|---|---|
| DOCX cue extraction | **Working** — highlight, colour, tracked changes, headers, footers, notes |
| Cue-preserving DOCX writing | **Working** — the round trip preserves the cue layer |
| Local service | **Working** — loopback-only, token-gated, no content logging |
| Chrome extension | **Working** — mode A interception, mode B fallback, popup |
| PDF cue recovery | Not implemented — recovering PDF cues needs geometric analysis of filled rectangles against character bounding boxes. The service reports this honestly rather than pretending. |

---

## Licence

MIT. See [LICENSE](LICENSE).

Third-party notices: `jszip` (MIT), `vitest` (MIT).
