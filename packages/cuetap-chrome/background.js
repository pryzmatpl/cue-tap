/**
 * CueTap service worker.
 *
 * Responsibilities:
 * - Hold the connection settings for the local parse service.
 * - Mint and store a per-install token.
 * - Answer the content script's "what should I do on this site?" question.
 * - Show a badge that says, honestly, whether interception is active.
 *
 * The worker never sees document content. It forwards metadata and requests.
 *
 * Plain JavaScript with JSDoc types: it ships inside a Chrome extension,
 * where no build step runs.
 */

import { DEFAULT_SITES } from "./shared/sites.js";

/**
 * Connection settings for the local parse service.
 *
 * @typedef {Object} ServiceSettings
 * @property {string} serviceUrl - Base URL of the local service.
 * @property {string} token - Bearer token for the local service.
 * @property {boolean} enabled - Whether CueTap is globally enabled.
 */

/** The storage key for the settings. */
const SETTINGS_KEY = "cuetap.settings";

/** The default service URL. */
const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";

/** Badge colours, by state. */
const BADGE_COLOURS = {
  active: "#1a7f37",
  attached: "#0969da",
  idle: "#57606a",
  error: "#cf222e",
};

/**
 * Read the current settings, filling in defaults.
 *
 * @returns {Promise<ServiceSettings>}
 */
export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY];
  return {
    serviceUrl: value?.serviceUrl ?? DEFAULT_SERVICE_URL,
    token: value?.token ?? "",
    enabled: value?.enabled ?? true,
  };
}

/**
 * Persist the settings.
 *
 * @param {Partial<ServiceSettings>} patch
 * @returns {Promise<ServiceSettings>}
 */
export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Mint a token for the local service.
 *
 * The token is generated once per install and stored locally. It is never
 * transmitted anywhere except to the loopback service.
 *
 * @returns {Promise<string>}
 */
export async function ensureToken() {
  const settings = await getSettings();
  if (settings.token) return settings.token;

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  await setSettings({ token });
  return token;
}

/**
 * Load the site capability manifest.
 *
 * @returns {Promise<{sites: any[], unverified: any[]}>}
 */
export async function loadSites() {
  try {
    const response = await fetch(chrome.runtime.getURL("sites.json"));
    if (!response.ok) return { sites: DEFAULT_SITES, unverified: [] };
    const manifest = await response.json();
    if (!manifest.sites) return { sites: DEFAULT_SITES, unverified: [] };
    return manifest;
  } catch {
    return { sites: DEFAULT_SITES, unverified: [] };
  }
}

/**
 * Find the site entry that matches a hostname.
 *
 * A host matches when it is the hostname itself or a subdomain of it — the
 * same rule Chrome uses for host permissions.
 *
 * @param {any[]} sites
 * @param {string} hostname
 * @returns {any|undefined}
 */
export function matchSite(sites, hostname) {
  for (const site of sites) {
    for (const host of site.hosts) {
      if (hostname === host || hostname.endsWith(`.${host}`)) return site;
    }
  }
  return undefined;
}

/**
 * Set the badge for the current tab.
 *
 * @param {number} tabId
 * @param {"active"|"attached"|"idle"|"error"} state
 * @param {number} [count]
 */
async function setBadge(tabId, state, count) {
  const text =
    state === "attached" && count !== undefined ? String(count) : state === "active" ? "on" : "";
  const colour = BADGE_COLOURS[state];
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: colour });
    }
  } catch {
    // The tab may have gone away. Nothing to do.
  }
}

/**
 * Message from a content script asking what to do on this page.
 *
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleProbe(sender) {
  const settings = await getSettings();
  const hostname = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
  const manifest = await loadSites();
  const site = hostname ? matchSite(manifest.sites, hostname) : undefined;

  if (!settings.enabled || !site || site.status !== "verified") {
    return { active: false };
  }

  await setBadge(sender.tab?.id ?? -1, "active");
  return {
    active: true,
    mode: site.mode,
    site,
    serviceUrl: settings.serviceUrl,
    token: settings.token || (await ensureToken()),
  };
}

/** Wire up the message handlers. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  if (type === "probe") {
    void handleProbe(sender).then(sendResponse);
    return true;
  }

  if (type === "report") {
    const payload = message;
    if (sender.tab?.id !== undefined) {
      void setBadge(sender.tab.id, payload.state, payload.count);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (type === "settings") {
    // The popup may send a patch alongside a read.
    const patch = {};
    if (typeof message.serviceUrl === "string") patch.serviceUrl = message.serviceUrl;
    if (typeof message.enabled === "boolean") patch.enabled = message.enabled;

    if (Object.keys(patch).length > 0) {
      void setSettings(patch).then(() => getSettings()).then(sendResponse);
    } else {
      void getSettings().then(sendResponse);
    }
    return true;
  }

  return false;
});
