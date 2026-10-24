# CueTap for Chrome

**Keep the author's emphasis.**

A Chrome extension that recovers the highlighting and colour you used in a
document, and delivers the document to the chat composer with the emphasis
intact.

---

## Install

1. Clone the repository and install the service:

   ```sh
   git clone https://github.com/pryzmatpl/cue-tap.git
   cd cue-tap
   npm install
   ```

2. Start the local parse service:

   ```sh
   npx cuelayer serve --port 8765
   ```

3. Load the extension:

   - open `chrome://extensions`
   - turn on **Developer mode**
   - **Load unpacked** → select this directory

4. Open the CueTap popup. It shows whether the service is reachable and which
   sites are supported.

---

## How it works

### Mode A — network interception

On a composer that posts the file bytes over HTTP, the content script wraps
`fetch` before the composer builds its request. When a multipart upload
arrives, CueTap:

1. parses the body and locates the file part;
2. posts the bytes to the local service;
3. receives a cue-preserving copy of the document;
4. splices it into the request in place of the original;
5. corrects `Content-Length`.

Every other part of the request — conversation context, images, other files —
is preserved **byte-for-byte**. The multipart parser reports byte ranges and
rewrites by splicing, never by re-serialising.

### Mode B — client-side composers

Some composers read the file in the browser and never post the raw bytes. No
plugin can rewrite that upload. CueTap attaches the cue-preserving text
alongside the file instead, and says so in the composer.

### Sites CueTap does not touch

CueTap only acts on sites listed in [`sites.json`](sites.json) whose upload
mechanism has actually been observed. On anything else it stays inert.

A site that mentions the boundary string inside a file's *content* is handled
correctly: the multipart parser only treats a boundary at the start of a line
as a delimiter.

---

## Permissions, and why each one is there

| Permission | Why |
|---|---|
| `storage` | Remember the service URL, the token, and the on/off state. |
| `activeTab` | Read the current tab's URL to decide whether the site is supported. |
| `scripting` | Inject the content script into supported sites only. |
| `http://127.0.0.1/*`, `http://localhost/*` | Talk to the local parse service. |

There is **no** `<all_urls>`, **no** `webRequest`, **no** `cookies`, **no**
`history`, **no** `downloads`, **no** `management` and **no** `debugger`.

The extension sees every upload you make. That is a credential-adjacent
position — contracts, NDAs, HR paperwork, medical records. Keeping the
permission set this small is what makes the extension installable at all.

---

## Privacy

- Everything runs on your machine.
- No telemetry. No analytics, no crash reporting, no remote configuration.
- Document content is never logged — the service logs filename, size and cue
  counts only.
- The service binds to `127.0.0.1` and rejects requests from any other peer.
- The bearer token is generated per install and never leaves the machine.
- The only network destination the extension ever contacts is the loopback
  service.

---

## The popup

The popup makes the mechanism legible:

- whether CueTap is active on this page, and in which mode;
- whether the local service is reachable;
- which sites are supported, and which are not yet verified;
- a toggle to turn CueTap off entirely;
- the service URL, in case you run it somewhere other than the default.

---

## Development

```sh
npm install
npm test          # the multipart parser tests
npm run lint      # syntax check every shipped file
```

The extension ships as plain JavaScript with JSDoc types. Chrome runs no
build step, so neither does CueTap.

Regenerate the icons with:

```sh
node scripts/generate-icons.mjs
```

---

## Licence

MIT.
