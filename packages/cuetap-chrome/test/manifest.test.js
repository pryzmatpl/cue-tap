import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Read a file from the extension root. */
function read(...parts) {
  return readFileSync(join(ROOT, ...parts), "utf-8");
}

describe("the extension manifest", () => {
  const manifest = JSON.parse(read("manifest.json"));

  it("is a Manifest V3 extension", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("names the service worker", () => {
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.type).toBe("module");
  });

  it("requests no dangerous permissions", () => {
    const permissions = manifest.permissions ?? [];
    for (const forbidden of [
      "cookies",
      "history",
      "downloads",
      "management",
      "debugger",
      "webRequest",
      "webRequestBlocking",
      "<all_urls>",
    ]) {
      expect(permissions).not.toContain(forbidden);
    }
  });

  it("requests only the permissions the extension actually uses", () => {
    expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting", "storage"]);
  });

  it("grants host permissions to the loopback service only", () => {
    expect(manifest.host_permissions.sort()).toEqual([
      "http://127.0.0.1/*",
      "http://localhost/*",
    ]);
  });

  it("has no content-script or web-accessible-resource leaks", () => {
    expect(manifest.content_scripts).toBeUndefined();
    const resources = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources);
    expect(resources).toEqual(["sites.json"]);
  });

  it("ships a popup", () => {
    expect(manifest.action.default_popup).toBe("popup/popup.html");
  });

  it("declares every icon it references", () => {
    for (const path of Object.values(manifest.icons)) {
      expect(() => read(path)).not.toThrow();
    }
    for (const path of Object.values(manifest.action.default_icon)) {
      expect(() => read(path)).not.toThrow();
    }
  });
});

describe("the site capability manifest", () => {
  const sites = JSON.parse(read("sites.json"));

  it("declares a protocol version", () => {
    expect(sites.protocol).toBe(1);
  });

  it("gives every site an id, name, hosts, mode and status", () => {
    for (const site of sites.sites) {
      expect(site.id).toBeTruthy();
      expect(site.name).toBeTruthy();
      expect(Array.isArray(site.hosts)).toBe(true);
      expect(site.hosts.length).toBeGreaterThan(0);
      expect(["network", "input", "unknown"]).toContain(site.mode);
      expect(["verified", "unverified", "broken"]).toContain(site.status);
    }
  });

  it("records the date each verified site was verified", () => {
    for (const site of sites.sites) {
      if (site.status === "verified") {
        expect(site.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("does not claim a site is verified without a mechanism", () => {
    for (const site of sites.sites) {
      if (site.status === "verified") {
        expect(site.mode).not.toBe("unknown");
      }
    }
  });

  it("has no duplicate site ids", () => {
    const ids = sites.sites.map((site) => site.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not list the same host under two sites", () => {
    const hosts = sites.sites.flatMap((site) => site.hosts);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it("keeps unsurveyed sites out of the interceptable list", () => {
    for (const site of sites.unverified ?? []) {
      expect(sites.sites.find((entry) => entry.id === site.id)).toBeUndefined();
    }
  });
});

describe("the extension sources", () => {
  it("never logs document content", () => {
    for (const file of ["background.js", "content/content.js", "popup/popup.js"]) {
      const source = read(file);
      expect(source).not.toMatch(/console\.log\(.*(?:text|content|body)/i);
    }
  });

  it("never contacts a remote host", () => {
    for (const file of ["background.js", "content/content.js", "popup/popup.js"]) {
      const source = read(file);
      const urls = source.match(/https?:\/\/[^\s"')]+/g) ?? [];
      for (const url of urls) {
        expect(url).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost)/);
      }
    }
  });

  it("sends the service request only to the configured service URL", () => {
    const source = read("content/content.js");
    expect(source).toContain("state.serviceUrl");
    expect(source).not.toMatch(/fetch\(\s*["']https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it("refuses to rewrite a signed or chunked upload", () => {
    const source = read("content/content.js");
    expect(source).toContain("hasBodySignature");
    expect(source).toContain("isChunkedUpload");
  });

  it("falls through to the original request on any failure", () => {
    const source = read("content/content.js");
    expect(source).toContain("return originalFetch(input, init)");
    expect(source).toMatch(/catch\s*\{[\s\S]{0,200}originalFetch/);
  });
});
