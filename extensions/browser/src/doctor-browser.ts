import { note } from "openclaw/plugin-sdk/browser-setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  parseBrowserMajorVersion,
  readBrowserVersion,
  resolveGoogleChromeExecutableForPlatform,
} from "./browser/chrome.executables.js";
import type { OpenClawConfig } from "./config/config.js";
import { asRecord } from "./record-shared.js";

const CHROME_MCP_MIN_MAJOR = 144;
const REMOTE_DEBUGGING_PAGES = [
  "chrome://inspect/#remote-debugging",
  "brave://inspect/#remote-debugging",
  "edge://inspect/#remote-debugging",
].join(", ");

type ExistingSessionProfile = {
  name: string;
  userDataDir?: string;
};

function collectChromeMcpProfiles(cfg: OpenClawConfig): ExistingSessionProfile[] {
  const browser = asRecord(cfg.browser);
  if (!browser) {
    return [];
  }

  const profiles = new Map<string, ExistingSessionProfile>();
  const defaultProfile = normalizeOptionalString(browser.defaultProfile) ?? "";
  if (defaultProfile === "user") {
    profiles.set("user", { name: "user" });
  }

  const configuredProfiles = asRecord(browser.profiles);
  if (!configuredProfiles) {
    return [...profiles.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  for (const [profileName, rawProfile] of Object.entries(configuredProfiles)) {
    const profile = asRecord(rawProfile);
    const driver = normalizeOptionalString(profile?.driver) ?? "";
    if (driver === "existing-session") {
      profiles.set(profileName, {
        name: profileName,
        userDataDir: normalizeOptionalString(profile?.userDataDir),
      });
    }
  }

  return [...profiles.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function noteChromeMcpBrowserReadiness(
  cfg: OpenClawConfig,
  deps?: {
    platform?: NodeJS.Platform;
    noteFn?: typeof note;
    resolveChromeExecutable?: (platform: NodeJS.Platform) => { path: string } | null;
    readVersion?: (executablePath: string) => string | null;
  },
) {
  const profiles = collectChromeMcpProfiles(cfg);
  if (profiles.length === 0) {
    return;
  }

  const noteFn = deps?.noteFn ?? note;
  const platform = deps?.platform ?? process.platform;
  const resolveChromeExecutable =
    deps?.resolveChromeExecutable ?? resolveGoogleChromeExecutableForPlatform;
  const readVersion = deps?.readVersion ?? readBrowserVersion;
  const explicitProfiles = profiles.filter((profile) => profile.userDataDir);
  const autoConnectProfiles = profiles.filter((profile) => !profile.userDataDir);
  const profileLabel = profiles.map((profile) => profile.name).join(", ");

  if (autoConnectProfiles.length === 0) {
    noteFn(
      [
        `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
        "- These profiles use an explicit Chromium user data directory instead of Chrome's default auto-connect path.",
        `- Verify the matching Chromium-based browser is version ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node.`,
        `- Enable remote debugging in that browser's inspect page (${REMOTE_DEBUGGING_PAGES}).`,
        "- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
      ].join("\n"),
      "Browser",
    );
    return;
  }

  const chrome = resolveChromeExecutable(platform);
  const autoProfileLabel = autoConnectProfiles.map((profile) => profile.name).join(", ");

  if (!chrome) {
    const lines = [
      `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
      `- Google Chrome was not found on this host for auto-connect profile(s): ${autoProfileLabel}. OpenClaw does not bundle Chrome.`,
      `- Install Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node, or set browser.profiles.<name>.userDataDir for a different Chromium-based browser.`,
      `- Enable remote debugging in the browser inspect page (${REMOTE_DEBUGGING_PAGES}).`,
      "- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
      "- Docker, headless, and sandbox browser flows stay on raw CDP; this check only applies to host-local Chrome MCP attach.",
    ];
    if (explicitProfiles.length > 0) {
      lines.push(
        `- Profiles with explicit userDataDir skip Chrome auto-detection: ${explicitProfiles
          .map((profile) => profile.name)
          .join(", ")}.`,
      );
    }
    noteFn(lines.join("\n"), "Browser");
    return;
  }

  const versionRaw = readVersion(chrome.path);
  const major = parseBrowserMajorVersion(versionRaw);
  const lines = [
    `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
    `- Chrome path: ${chrome.path}`,
  ];

  if (!versionRaw || major === null) {
    lines.push(
      `- Could not determine the installed Chrome version. Chrome MCP requires Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on this host.`,
    );
  } else if (major < CHROME_MCP_MIN_MAJOR) {
    lines.push(
      `- Detected Chrome ${versionRaw}, which is too old for Chrome MCP existing-session attach. Upgrade to Chrome ${CHROME_MCP_MIN_MAJOR}+.`,
    );
  } else {
    lines.push(`- Detected Chrome ${versionRaw}.`);
  }

  lines.push(`- Enable remote debugging in the browser inspect page (${REMOTE_DEBUGGING_PAGES}).`);
  lines.push(
    "- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
  );
  if (explicitProfiles.length > 0) {
    lines.push(
      `- Profiles with explicit userDataDir still need manual validation of the matching Chromium-based browser: ${explicitProfiles
        .map((profile) => profile.name)
        .join(", ")}.`,
    );
  }

  noteFn(lines.join("\n"), "Browser");
}
