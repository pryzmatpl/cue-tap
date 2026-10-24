/**
 * The CueTap popup.
 *
 * The popup's job is to make the mechanism legible. A user should be able to
 * see, at a glance:
 *
 * - whether CueTap is active on this page,
 * - whether the local service is reachable,
 * - exactly which cues were recovered from the last document, and
 * - which sites are supported.
 *
 * Nothing here sends document content anywhere. The service URL is the only
 * network destination, and it must be a loopback address.
 *
 * Plain JavaScript with JSDoc types: it ships inside a Chrome extension,
 * where no build step runs.
 */

import { matchSite } from "../shared/sites.js";

/** The popup's view of the world. */
const state = {
  enabled: true,
  serviceUrl: "http://127.0.0.1:8765",
  token: "",
  sites: [],
  unverified: [],
};

/**
 * Get an element by id, failing loudly when it is missing.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`popup: missing element #${id}`);
  return element;
}

/**
 * Read the settings from the service worker.
 */
async function loadSettings() {
  try {
    const settings = await chrome.runtime.sendMessage({ type: "settings" });
    state.serviceUrl = settings?.serviceUrl ?? state.serviceUrl;
    state.token = settings?.token ?? "";
    state.enabled = settings?.enabled ?? true;
  } catch {
    // The worker may be asleep. Defaults are fine.
  }
}

/** Load the site capability manifest. */
async function loadSites() {
  try {
    const response = await fetch(chrome.runtime.getURL("sites.json"));
    const manifest = await response.json();
    state.sites = manifest.sites ?? [];
    state.unverified = manifest.unverified ?? [];
  } catch {
    state.sites = [];
  }
}

/**
 * Whether the service URL points at this machine.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Check that the local service is reachable.
 *
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
async function checkService() {
  if (!isLoopback(state.serviceUrl)) {
    return { ok: false, detail: "The service URL must be a loopback address." };
  }
  try {
    const response = await fetch(`${state.serviceUrl}/health`, { cache: "no-store" });
    if (!response.ok) return { ok: false, detail: `The service answered ${response.status}.` };
    const body = await response.json();
    return { ok: true, detail: `Reachable — protocol ${body.protocol ?? "?"}.` };
  } catch {
    return { ok: false, detail: "Not reachable. Start it with `cuetap serve`." };
  }
}

/** Paint the site list. */
function renderSites() {
  const list = $("site-list");
  list.replaceChildren();

  for (const site of state.sites) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site.name;
    const mode = document.createElement("span");
    mode.className = "site-mode";
    mode.textContent = site.mode === "network" ? "enriched in place" : "text attached";
    item.append(name, mode);
    list.append(item);
  }

  for (const site of state.unverified) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site.name;
    const mode = document.createElement("span");
    mode.className = "site-mode";
    mode.textContent = "not supported yet";
    item.append(name, mode);
    list.append(item);
  }
}

/** Paint the status line for the current tab. */
async function renderStatus() {
  const dot = $("dot");
  const line = $("status-line");
  const detail = $("status-detail");

  dot.className = "dot";
  line.textContent = "Checking…";
  detail.textContent = "";

  let hostname = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) hostname = new URL(tab.url).hostname;
  } catch {
    // Not permitted in some contexts. Fall through to the generic state.
  }

  if (!state.enabled) {
    line.textContent = "CueTap is off";
    detail.textContent = "Turn it on below to recover cues on supported sites.";
    return;
  }

  if (!hostname) {
    line.textContent = "CueTap is ready";
    detail.textContent = "Open a supported chat composer to attach cues.";
    return;
  }

  const site = matchSite(state.sites, hostname);
  if (!site) {
    line.textContent = "Not a supported site";
    detail.textContent = `${hostname} is not in the capability manifest. CueTap stays inert here.`;
    return;
  }

  if (site.status !== "verified") {
    dot.className = "dot warn";
    line.textContent = `${site.name} — not yet verified`;
    detail.textContent = site.notes ?? "CueTap does not intercept on this site yet.";
    return;
  }

  dot.className = "dot on";
  line.textContent = `${site.name} — active`;
  detail.textContent =
    site.mode === "network"
      ? "Uploaded documents are enriched before they leave the page."
      : "Cue-preserving text is attached alongside the file.";
}

/**
 * A colour approximating a Word highlight name, for the swatch.
 *
 * @param {string|undefined} name
 * @returns {string}
 */
function highlightColour(name) {
  switch ((name ?? "").toLowerCase()) {
    case "yellow":
      return "#fde68a";
    case "green":
      return "#bbf7d0";
    case "cyan":
      return "#a5f3fc";
    case "magenta":
      return "#f5d0fe";
    case "blue":
      return "#bfdbfe";
    case "red":
      return "#fecaca";
    case "darkblue":
      return "#93c5fd";
    case "darkgreen":
      return "#86efac";
    case "darkred":
      return "#fca5a5";
    default:
      return "#e5e7eb";
  }
}

/**
 * Truncate a string for display.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Save the settings.
 *
 * @param {{enabled?:boolean, serviceUrl?:string}} patch
 */
async function saveSettings(patch) {
  await chrome.runtime.sendMessage({ type: "settings", ...patch });
}

/** Wire up the popup. */
async function main() {
  await loadSettings();
  await loadSites();

  $("service-url").value = state.serviceUrl;
  $("enabled").checked = state.enabled;

  renderSites();
  await renderStatus();

  const serviceState = $("service-state");
  const service = await checkService();
  serviceState.textContent = service.detail;
  if (!service.ok) $("dot").className = "dot warn";

  $("test-service").addEventListener("click", async () => {
    const result = await checkService();
    serviceState.textContent = result.detail;
  });

  $("service-url").addEventListener("change", async (event) => {
    const value = event.target.value.trim();
    await saveSettings({ serviceUrl: value });
    state.serviceUrl = value;
    const result = await checkService();
    serviceState.textContent = result.detail;
  });

  $("enabled").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    await saveSettings({ enabled });
    state.enabled = enabled;
    await renderStatus();
  });
}

void main();
