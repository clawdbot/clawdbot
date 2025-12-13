import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensurePortAvailable } from "../infra/ports.js";
import { logInfo, logWarn } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { CONFIG_DIR } from "../utils.js";
import type { ResolvedBrowserConfig } from "./config.js";
import {
  DEFAULT_CLAWD_BROWSER_COLOR,
  DEFAULT_CLAWD_BROWSER_PROFILE_NAME,
} from "./constants.js";

export type BrowserExecutable = {
  kind: "canary" | "chromium" | "chrome";
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

  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate;
  }

  return null;
}

export function resolveClawdUserDataDir() {
  return path.join(
    CONFIG_DIR,
    "browser",
    DEFAULT_CLAWD_BROWSER_PROFILE_NAME,
    "user-data",
  );
}

function decoratedMarkerPath(userDataDir: string) {
  return path.join(userDataDir, ".clawd-profile-decorated");
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!exists(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath: string, data: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
  opts?: { color?: string },
) {
  const desiredName = DEFAULT_CLAWD_BROWSER_PROFILE_NAME;
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
  cdpPort: number,
  timeoutMs = 500,
): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function launchClawdChrome(
  resolved: ResolvedBrowserConfig,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<RunningChrome> {
  await ensurePortAvailable(resolved.cdpPort);

  const exe = process.platform === "darwin" ? findChromeExecutableMac() : null;
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome Canary/Chromium/Chrome on macOS).",
    );
  }

  const userDataDir = resolveClawdUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    DEFAULT_CLAWD_BROWSER_PROFILE_NAME,
    (resolved.color ?? DEFAULT_CLAWD_BROWSER_COLOR).toUpperCase(),
  );

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${resolved.cdpPort}`,
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
      decorateClawdProfile(userDataDir, { color: resolved.color });
      logInfo(
        `🦞 clawd browser profile decorated (${resolved.color})`,
        runtime,
      );
    } catch (err) {
      logWarn(
        `clawd browser profile decoration failed: ${String(err)}`,
        runtime,
      );
    }
  }

  const proc = spawnOnce();

  // Wait for CDP to come up.
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(resolved.cdpPort, 500)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isChromeReachable(resolved.cdpPort, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(`Failed to start Chrome CDP on port ${resolved.cdpPort}.`);
  }

  const pid = proc.pid ?? -1;
  logInfo(
    `🦞 clawd browser started (${exe.kind}) on 127.0.0.1:${resolved.cdpPort} (pid ${pid})`,
    runtime,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: resolved.cdpPort,
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
    if (!(await isChromeReachable(running.cdpPort, 200))) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
