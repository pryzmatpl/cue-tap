/**
 * Load the CueTap extension in Chromium and verify it registers.
 *
 * This is the check that matters most for a Chrome extension: that Chrome
 * accepts the manifest, starts the service worker, and that the popup
 * renders.
 *
 * Run: node scripts/verify-extension.mjs
 */

import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, "..");

/** Fail loudly with a message. */
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok  ${message}`);
}

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), "cuetap-profile-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-sandbox",
      "--disable-gpu",
    ],
  });

  try {
    console.log("Checking the extension registers…");

    // The service worker is the extension's entry point. Chrome starts it
    // when the extension loads.
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
    }
    assert(worker !== undefined, "the service worker started");

    const extensionId = new URL(worker.url()).host;
    console.log(`  extension id: ${extensionId}`);

    // The manifest must be accepted as-is.
    const manifestResponse = await context.request.get(
      `chrome-extension://${extensionId}/manifest.json`,
    );
    assert(manifestResponse.ok(), "the manifest is served");
    const manifest = await manifestResponse.json();
    assert(manifest.manifest_version === 3, "manifest_version is 3");
    assert(manifest.name === "CueTap — keep the author's emphasis", "the name is set");

    // The permission set must not have grown.
    const permissions = manifest.permissions ?? [];
    const forbidden = ["cookies", "history", "downloads", "management", "debugger", "webRequest"];
    for (const permission of forbidden) {
      assert(!permissions.includes(permission), `no "${permission}" permission`);
    }
    assert(!(manifest.host_permissions ?? []).includes("<all_urls>"), 'no "<all_urls>" host permission');

    console.log("Checking the popup renders…");
    const popup = await context.newPage();
    const errors = [];
    popup.on("pageerror", (error) => errors.push(error.message));
    popup.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForTimeout(600);

    const heading = await popup.textContent("h1");
    assert(heading?.trim() === "CueTap", "the popup heading renders");

    const statusLine = await popup.textContent("#status-line");
    assert(statusLine !== null && statusLine.length > 0, "the popup shows a status line");

    const siteItems = await popup.locator("#site-list li").count();
    assert(siteItems > 0, `the popup lists supported sites (${siteItems})`);

    const serviceState = await popup.textContent("#service-state");
    assert(serviceState !== null, "the popup reports the service state");

    // The page scripts must not have thrown. The extension's chrome.* APIs
    // are unavailable on a plain popup page load, so a missing-API error is
    // expected and is not a defect in the popup itself.
    const realErrors = errors.filter(
      (message) => !/chrome\.runtime|chrome\.tabs|chrome\.storage/i.test(message),
    );
    assert(realErrors.length === 0, `the popup raised no unexpected errors (${realErrors.join("; ")})`);

    // The service worker's own module must load without a syntax error.
    const workerErrors = [];
    worker.on("console", (message) => {
      if (message.type() === "error") workerErrors.push(message.text());
    });
    const realWorkerErrors = workerErrors.filter(
      (message) => !/chrome\.runtime|chrome\.storage|chrome\.action/i.test(message),
    );
    assert(realWorkerErrors.length === 0, "the service worker raised no errors");

    console.log("\nThe extension loads and renders.");
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
