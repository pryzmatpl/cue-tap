/**
 * Shared definitions for the CueTap extension.
 *
 * This module is imported by the service worker and used by the content
 * scripts. It holds no state.
 *
 * Plain JavaScript with JSDoc types: it ships inside a Chrome extension,
 * where no build step runs.
 */

/**
 * How a site's upload mechanism was observed.
 *
 * @typedef {"network"|"input"|"unknown"} UploadMode
 */

/**
 * How confidently a site's mechanism has been established.
 *
 * @typedef {"verified"|"unverified"|"broken"} SiteStatus
 */

/**
 * One site's capability entry.
 *
 * @typedef {Object} SiteEntry
 * @property {string} id - Stable identifier.
 * @property {string} name - Display name.
 * @property {string[]} hosts - Hostnames this entry covers.
 * @property {UploadMode} mode - The observed upload mechanism.
 * @property {SiteStatus} status - How confidently the mechanism is established.
 * @property {string} [verifiedOn] - ISO date the mechanism was last verified.
 * @property {string} [notes] - Free-text detail.
 */

/**
 * The capability manifest.
 *
 * @typedef {Object} SitesManifest
 * @property {number} [protocol] - Wire protocol version.
 * @property {SiteEntry[]} sites - Sites CueTap is willing to intercept.
 * @property {SiteEntry[]} [unverified] - Sites that have not been surveyed yet.
 */

/**
 * The built-in fallback list.
 *
 * Used only if `sites.json` cannot be read. Kept small and conservative:
 * a site is only here when its upload mechanism has been observed directly.
 *
 * @type {SiteEntry[]}
 */
export const DEFAULT_SITES = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    mode: "network",
    status: "verified",
  },
  {
    id: "claude",
    name: "Claude",
    hosts: ["claude.ai"],
    mode: "network",
    status: "verified",
  },
  {
    id: "gemini",
    name: "Gemini",
    hosts: ["gemini.google.com"],
    mode: "network",
    status: "verified",
  },
  {
    id: "discord",
    name: "Discord",
    hosts: ["discord.com"],
    mode: "network",
    status: "verified",
  },
  {
    id: "slack",
    name: "Slack",
    hosts: ["slack.com", "app.slack.com"],
    mode: "network",
    status: "verified",
  },
];
