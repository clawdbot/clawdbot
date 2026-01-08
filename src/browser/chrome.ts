import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging.js";
import { CONFIG_DIR } from "../utils.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import type {
  ResolvedBrowserConfig,
  ResolvedBrowserProfile,
} from "./config.js";
import {
  DEFAULT_CLAWD_BROWSER_COLOR,
  DEFAULT_CLAWD_BROWSER_PROFILE_NAME,
} from "./constants.js";

const log = createSubsystemLogger("browser").child("chrome");

export type BrowserExecutable = {
  kind: "canary" | "chromium" | "chrome" | "custom";
  path: string;
};

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
};

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findFirstExecutable(
  candidates: Array<BrowserExecutable>,
): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate;
  }

  return null;
}

export function findChromeExecutableMac(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    {
      kind: "canary",
      path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    },
    {
      kind: "canary",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ),
    },
    {
      kind: "chromium",
      path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    },
    {
      kind: "chromium",
      path: path.join(
        os.homedir(),
        "Applications/Chromium.app/Contents/MacOS/Chromium",
      ),
    },
    {
      kind: "chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    {
      kind: "chrome",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    },
  ];

  return findFirstExecutable(candidates);
}

export function findChromeExecutableLinux(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    { kind: "chrome", path: "/usr/bin/google-chrome" },
    { kind: "chrome", path: "/usr/bin/google-chrome-stable" },
    { kind: "chromium", path: "/usr/bin/chromium" },
    { kind: "chromium", path: "/usr/bin/chromium-browser" },
    { kind: "chromium", path: "/snap/bin/chromium" },
    { kind: "chrome", path: "/usr/bin/chrome" },
  ];

  return findFirstExecutable(candidates);
}

export function findChromeExecutableWindows(): BrowserExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  // Must use bracket notation: variable name contains parentheses
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  const joinWin = path.win32.join;
  const candidates: Array<BrowserExecutable> = [];

  if (localAppData) {
    // Chrome Canary (user install)
    candidates.push({
      kind: "canary",
      path: joinWin(
        localAppData,
        "Google",
        "Chrome SxS",
        "Application",
        "chrome.exe",
      ),
    });
    // Chromium (user install)
    candidates.push({
      kind: "chromium",
      path: joinWin(localAppData, "Chromium", "Application", "chrome.exe"),
    });
    // Chrome (user install)
    candidates.push({
      kind: "chrome",
      path: joinWin(
        localAppData,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    });
  }

  // Chrome (system install, 64-bit)
  candidates.push({
    kind: "chrome",
    path: joinWin(
      programFiles,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  });
  // Chrome (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "chrome",
    path: joinWin(
      programFilesX86,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  });

  return findFirstExecutable(candidates);
}

export function resolveBrowserExecutableForPlatform(
  resolved: ResolvedBrowserConfig,
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (resolved.executablePath) {
    if (!exists(resolved.executablePath)) {
      throw new Error(
        `browser.executablePath not found: ${resolved.executablePath}`,
      );
    }
    return { kind: "custom", path: resolved.executablePath };
  }

  if (platform === "darwin") return findChromeExecutableMac();
  if (platform === "linux") return findChromeExecutableLinux();
  if (platform === "win32") return findChromeExecutableWindows();
  return null;
}

function resolveBrowserExecutable(
  resolved: ResolvedBrowserConfig,
): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

export function resolveClawdUserDataDir(
  profileName = DEFAULT_CLAWD_BROWSER_PROFILE_NAME,
) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function decoratedMarkerPath(userDataDir: string) {
  return path.join(userDataDir, ".clawd-profile-decorated");
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!exists(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath: string, data: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

function setDeep(obj: Record<string, unknown>, keys: string[], value: unknown) {
  let node: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1] ?? ""] = value;
}

function parseHexRgbToSignedArgbInt(hex: string): number | null {
  const cleaned = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  const rgb = Number.parseInt(cleaned, 16);
  const argbUnsigned = (0xff << 24) | rgb;
  // Chrome stores colors as signed 32-bit ints (SkColor).
  return argbUnsigned > 0x7fffffff
    ? argbUnsigned - 0x1_0000_0000
    : argbUnsigned;
}

function isProfileDecorated(
  userDataDir: string,
  desiredName: string,
  desiredColorHex: string,
): boolean {
  const desiredColorInt = parseHexRgbToSignedArgbInt(desiredColorHex);

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");

  const localState = safeReadJson(localStatePath);
  const profile = localState?.profile;
  const infoCache =
    typeof profile === "object" && profile !== null && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).info_cache
      : null;
  const info =
    typeof infoCache === "object" &&
    infoCache !== null &&
    !Array.isArray(infoCache) &&
    typeof (infoCache as Record<string, unknown>).Default === "object" &&
    (infoCache as Record<string, unknown>).Default !== null &&
    !Array.isArray((infoCache as Record<string, unknown>).Default)
      ? ((infoCache as Record<string, unknown>).Default as Record<
          string,
          unknown
        >)
      : null;

  const prefs = safeReadJson(preferencesPath);
  const browserTheme = (() => {
    const browser = prefs?.browser;
    const theme =
      typeof browser === "object" && browser !== null && !Array.isArray(browser)
        ? (browser as Record<string, unknown>).theme
        : null;
    return typeof theme === "object" && theme !== null && !Array.isArray(theme)
      ? (theme as Record<string, unknown>)
      : null;
  })();

  const autogeneratedTheme = (() => {
    const autogenerated = prefs?.autogenerated;
    const theme =
      typeof autogenerated === "object" &&
      autogenerated !== null &&
      !Array.isArray(autogenerated)
        ? (autogenerated as Record<string, unknown>).theme
        : null;
    return typeof theme === "object" && theme !== null && !Array.isArray(theme)
      ? (theme as Record<string, unknown>)
      : null;
  })();

  const nameOk =
    typeof info?.name === "string" ? info.name === desiredName : true;

  if (desiredColorInt == null) {
    // If the user provided a non-#RRGGBB value, we can only do best-effort.
    return nameOk;
  }

  const localSeedOk =
    typeof info?.profile_color_seed === "number"
      ? info.profile_color_seed === desiredColorInt
      : false;

  const prefOk =
    (typeof browserTheme?.user_color2 === "number" &&
      browserTheme.user_color2 === desiredColorInt) ||
    (typeof autogeneratedTheme?.color === "number" &&
      autogeneratedTheme.color === desiredColorInt);

  return nameOk && localSeedOk && prefOk;
}
/**
 * Best-effort profile decoration (name + lobster-orange). Chrome preference keys
 * vary by version; we keep this conservative and idempotent.
 */
export function decorateClawdProfile(
  userDataDir: string,
  opts?: { name?: string; color?: string },
) {
  const desiredName = opts?.name ?? DEFAULT_CLAWD_BROWSER_PROFILE_NAME;
  const desiredColor = (
    opts?.color ?? DEFAULT_CLAWD_BROWSER_COLOR
  ).toUpperCase();
  const desiredColorInt = parseHexRgbToSignedArgbInt(desiredColor);

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");

  const localState = safeReadJson(localStatePath) ?? {};
  // Common-ish shape: profile.info_cache.Default
  setDeep(
    localState,
    ["profile", "info_cache", "Default", "name"],
    desiredName,
  );
  setDeep(
    localState,
    ["profile", "info_cache", "Default", "shortcut_name"],
    desiredName,
  );
  setDeep(
    localState,
    ["profile", "info_cache", "Default", "user_name"],
    desiredName,
  );
  // Color keys are best-effort (Chrome changes these frequently).
  setDeep(
    localState,
    ["profile", "info_cache", "Default", "profile_color"],
    desiredColor,
  );
  setDeep(
    localState,
    ["profile", "info_cache", "Default", "user_color"],
    desiredColor,
  );
  if (desiredColorInt != null) {
    // These are the fields Chrome actually uses for profile/avatar tinting.
    setDeep(
      localState,
      ["profile", "info_cache", "Default", "profile_color_seed"],
      desiredColorInt,
    );
    setDeep(
      localState,
      ["profile", "info_cache", "Default", "profile_highlight_color"],
      desiredColorInt,
    );
    setDeep(
      localState,
      ["profile", "info_cache", "Default", "default_avatar_fill_color"],
      desiredColorInt,
    );
    setDeep(
      localState,
      ["profile", "info_cache", "Default", "default_avatar_stroke_color"],
      desiredColorInt,
    );
  }
  safeWriteJson(localStatePath, localState);

  const prefs = safeReadJson(preferencesPath) ?? {};
  setDeep(prefs, ["profile", "name"], desiredName);
  setDeep(prefs, ["profile", "profile_color"], desiredColor);
  setDeep(prefs, ["profile", "user_color"], desiredColor);
  if (desiredColorInt != null) {
    // Chrome refresh stores the autogenerated theme in these prefs (SkColor ints).
    setDeep(prefs, ["autogenerated", "theme", "color"], desiredColorInt);
    // User-selected browser theme color (pref name: browser.theme.user_color2).
    setDeep(prefs, ["browser", "theme", "user_color2"], desiredColorInt);
  }
  safeWriteJson(preferencesPath, prefs);

  try {
    fs.writeFileSync(
      decoratedMarkerPath(userDataDir),
      `${Date.now()}\n`,
      "utf-8",
    );
  } catch {
    // ignore
  }
}

export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<boolean> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const base = cdpUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/json/version`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<string | null> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) return null;
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canOpenWebSocket(
  wsUrl: string,
  timeoutMs = 800,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve(false);
      },
      Math.max(50, timeoutMs + 25),
    );
    ws.once("open", () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = 500,
  handshakeTimeoutMs = 800,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) return false;
  return await canOpenWebSocket(wsUrl, handshakeTimeoutMs);
}

export async function launchClawdChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(
      `Profile "${profile.name}" is remote; cannot launch local Chrome.`,
    );
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveClawdUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_CLAWD_BROWSER_COLOR).toUpperCase(),
  );

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--password-store=basic",
    ];

    if (resolved.headless) {
      // Best-effort; older Chromes may ignore.
      args.push("--headless=new");
      args.push("--disable-gpu");
    }
    if (resolved.noSandbox) {
      args.push("--no-sandbox");
      args.push("--disable-setuid-sandbox");
    }
    if (process.platform === "linux") {
      args.push("--disable-dev-shm-usage");
    }

    // Always open a blank tab to ensure a target exists.
    args.push("about:blank");

    return spawn(exe.path, args, {
      stdio: "pipe",
      env: {
        ...process.env,
        // Reduce accidental sharing with the user's env.
        HOME: os.homedir(),
      },
    });
  };

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (needsDecorate) {
    try {
      decorateClawdProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
      log.info(`🦞 clawd browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`clawd browser profile decoration failed: ${String(err)}`);
    }
  }

  const proc = spawnOnce();
  // Wait for CDP to come up.
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl, 500)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isChromeReachable(profile.cdpUrl, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".`,
    );
  }

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 clawd browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
  };
}

export async function stopClawdChrome(
  running: RunningChrome,
  timeoutMs = 2500,
) {
  const proc = running.proc;
  if (proc.killed) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) break;
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), 200))) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
