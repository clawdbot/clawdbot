/** Discovery and cookie import for macOS Chrome-family system profiles. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import type { OpenClawConfig } from "../config/config.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import { usesOpenClawMockKeychain } from "./chrome.profile-decoration.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import { getPwAiModule } from "./pw-ai-module.js";
import { type BrowserRouteContext, runProfileContextOperation } from "./server-context.js";
import { isProfileRestartRequiredError } from "./server-context.lifecycle.js";
import {
  readChromeCookiesDatabase,
  type CookieImportCounts,
  type KeychainSecretReader,
  type PlaywrightCookie,
  type SystemBrowser,
} from "./system-chrome-cookies.js";

export type SystemProfileInfo = {
  browser: SystemBrowser;
  id: string;
  name: string;
  hasCookies: boolean;
};

export type ImportSystemProfileParams = {
  browser?: string;
  systemProfile?: string;
  into?: string;
  domains?: string[];
  makeDefault?: boolean;
};

export type ImportSystemProfileResult = {
  ok: true;
  systemProfile: string;
  into: string;
  browser: SystemBrowser;
  cookies: { total: number; imported: number; failed: number; skipped: number };
  domains: string[];
};

type CreateProfile = (params: { name: string; driver?: "openclaw" }) => Promise<unknown>;

type SystemCookieReaderDeps = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  readSecret?: KeychainSecretReader;
};

type SystemProfileDeps = SystemCookieReaderDeps & {
  cfg?: OpenClawConfig;
};

const SYSTEM_BROWSER_DIRS: Record<SystemBrowser, string[]> = {
  chrome: ["Google", "Chrome"],
  brave: ["BraveSoftware", "Brave-Browser"],
  edge: ["Microsoft Edge"],
  chromium: ["Chromium"],
};

/** Normalize a supported Chrome-family browser identifier. */
function resolveSystemBrowser(value?: string): SystemBrowser {
  const browser = value?.trim().toLowerCase() || "chrome";
  if (browser === "chrome" || browser === "brave" || browser === "edge" || browser === "chromium") {
    return browser;
  }
  throw new Error(`unsupported system browser "${value}"; use chrome, brave, edge, or chromium`);
}

/** Resolve the macOS user-data root for one Chrome-family browser. */
function resolveSystemBrowserRoot(browser: SystemBrowser, homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "Application Support", ...SYSTEM_BROWSER_DIRS[browser]);
}

/** Prefer Chrome's current Network/Cookies location, then its legacy location. */
function resolveSystemCookiesFile(root: string, profileId: string): string | undefined {
  const candidates = [
    path.join(root, profileId, "Network", "Cookies"),
    path.join(root, profileId, "Cookies"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** Enforce the host-local platform contract before touching browser cookie state. */
export function assertSystemCookiePlatform(
  platform = process.platform,
  operation = "cookie access",
): void {
  if (platform !== "darwin") {
    throw new Error(`system profile ${operation} is only supported on macOS in this release`);
  }
}

/** Resolve one Chrome-family profile's source cookie database. */
export function resolveSystemCookieSource(
  params: { browser?: string; systemProfile?: string },
  deps: Pick<SystemCookieReaderDeps, "homeDir"> = {},
): { browser: SystemBrowser; systemProfile: string; cookiesFile: string } {
  const browser = resolveSystemBrowser(params.browser);
  const systemProfile = params.systemProfile?.trim() || "Default";
  const root = resolveSystemBrowserRoot(browser, deps.homeDir);
  const cookiesFile = resolveSystemCookiesFile(root, systemProfile);
  if (!cookiesFile) {
    throw new Error(`cookies database not found for ${browser} profile "${systemProfile}"`);
  }
  return { browser, systemProfile, cookiesFile };
}

function readProfileNames(root: string): Map<string, string> {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8")) as {
      profile?: {
        info_cache?: Record<string, { name?: unknown; user_name?: unknown; gaia_name?: unknown }>;
      };
    };
    const names = new Map<string, string>();
    for (const [id, info] of Object.entries(localState.profile?.info_cache ?? {})) {
      const displayName = [info.name, info.gaia_name, info.user_name].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      names.set(id, displayName?.trim() || id);
    }
    return names;
  } catch {
    return new Map();
  }
}

const SUPPORTED_SYSTEM_BROWSERS: readonly SystemBrowser[] = ["chrome", "brave", "edge", "chromium"];

function listOneBrowserProfiles(browser: SystemBrowser, homeDir?: string): SystemProfileInfo[] {
  const root = resolveSystemBrowserRoot(browser, homeDir);
  const names = readProfileNames(root);
  if (names.size === 0 && fs.existsSync(path.join(root, "Default"))) {
    names.set("Default", "Default");
  }
  return [...names.entries()]
    .filter(([id]) => id === "Default" || /^Profile \d+$/.test(id))
    .map(([id, name]) => ({
      browser,
      id,
      name,
      hasCookies: resolveSystemCookiesFile(root, id) !== undefined,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * Enumerate importable Chrome-family profiles without reading the Keychain. With
 * no browser specified, list every supported browser so discovery matches the
 * Chrome-family import support instead of assuming Chrome.
 */
export function listSystemProfiles(
  browserInput?: string,
  deps: Pick<SystemProfileDeps, "homeDir"> = {},
): SystemProfileInfo[] {
  const browsers = browserInput?.trim()
    ? [resolveSystemBrowser(browserInput)]
    : SUPPORTED_SYSTEM_BROWSERS;
  return browsers.flatMap((browser) => listOneBrowserProfiles(browser, deps.homeDir));
}

/** Create a transactionally coherent snapshot while Chrome may be writing its WAL. */
function snapshotCookieDatabase(source: string): { databasePath: string; cleanup: () => void } {
  const tmpRoot = resolvePreferredOpenClawTmpDir();
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tmpRoot, "openclaw-system-cookies-"));
  const databasePath = path.join(tempDir, "Cookies");
  const sourceDatabase = openNodeSqliteDatabase(source, { readOnly: true });
  try {
    sourceDatabase.exec("PRAGMA busy_timeout = 5000");
    sourceDatabase.prepare("VACUUM INTO ?").run(databasePath);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    sourceDatabase.close();
  }
  return {
    databasePath,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

/** Snapshot and decrypt cookies from one local macOS Chrome-family profile. */
export async function readSystemProfileCookies(
  params: {
    browser?: string;
    systemProfile?: string;
    domains?: readonly string[];
    signal?: AbortSignal;
  },
  deps: SystemCookieReaderDeps = {},
): Promise<{
  browser: SystemBrowser;
  systemProfile: string;
  cookies: PlaywrightCookie[];
  counts: CookieImportCounts;
  domains: string[];
}> {
  assertSystemCookiePlatform(deps.platform);
  const source = resolveSystemCookieSource(params, deps);
  const snapshot = snapshotCookieDatabase(source.cookiesFile);
  try {
    const decrypted = await readChromeCookiesDatabase({
      browser: source.browser,
      databasePath: snapshot.databasePath,
      domains: params.domains,
      readSecret: deps.readSecret,
      signal: params.signal,
    });
    return { browser: source.browser, systemProfile: source.systemProfile, ...decrypted };
  } finally {
    snapshot.cleanup();
  }
}

/** Import decrypted system-profile cookies into one managed OpenClaw profile. */
export async function importSystemProfileCookies(
  params: ImportSystemProfileParams,
  runtime: {
    ctx: BrowserRouteContext;
    createProfile: CreateProfile;
    signal?: AbortSignal;
    finalize?: (result: ImportSystemProfileResult) => Promise<void>;
  },
  deps: SystemProfileDeps = {},
): Promise<ImportSystemProfileResult> {
  assertSystemCookiePlatform(deps.platform, "import");
  const cfg = deps.cfg ?? getRuntimeConfig();
  if (cfg.browser?.allowSystemProfileImport === false) {
    throw new Error("system profile import is disabled (browser.allowSystemProfileImport=false)");
  }

  const browser = resolveSystemBrowser(params.browser);
  const systemProfile = params.systemProfile?.trim() || "Default";
  const into = params.into?.trim() || "imported";
  const available = listSystemProfiles(browser, { homeDir: deps.homeDir });
  const sourceProfile = available.find((profile) => profile.id === systemProfile);
  if (!sourceProfile) {
    throw new Error(`system browser profile "${systemProfile}" was not found for ${browser}`);
  }
  const root = resolveSystemBrowserRoot(browser, deps.homeDir);
  const cookiesFile = resolveSystemCookiesFile(root, sourceProfile.id);
  if (!cookiesFile) {
    throw new Error(`cookies database not found for ${browser} profile "${systemProfile}"`);
  }

  if (!(into in runtime.ctx.state().resolved.profiles)) {
    await runtime.createProfile({ name: into, driver: "openclaw" });
  }
  const profileCtx = runtime.ctx.forProfile(into);
  if (
    profileCtx.profile.driver !== "openclaw" ||
    !profileCtx.profile.cdpIsLoopback ||
    profileCtx.profile.attachOnly
  ) {
    throw new Error(
      `profile "${into}" is not a locally managed OpenClaw profile; import into a fresh profile name`,
    );
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runProfileContextOperation(
        profileCtx,
        runtime.signal,
        async (signal, profileRuntime) => {
          await profileCtx.ensureBrowserAvailable({ headless: true, signal });
          const userDataDir = resolveOpenClawUserDataDir(into);
          const runningUserDataDir = profileRuntime.running?.userDataDir;
          if (
            !runningUserDataDir ||
            path.resolve(runningUserDataDir) !== path.resolve(userDataDir)
          ) {
            throw new Error(
              `managed profile "${into}" is not owned by this OpenClaw browser runtime; stop it and import into a fresh profile name`,
            );
          }
          if (!usesOpenClawMockKeychain(userDataDir)) {
            throw new Error(
              `managed profile "${into}" does not use the OpenClaw mock keychain; import into a fresh profile name`,
            );
          }

          const decrypted = await readSystemProfileCookies(
            { browser, systemProfile, domains: params.domains, signal },
            deps,
          );
          signal.throwIfAborted();
          const pw = await getPwAiModule({ mode: "strict" });
          if (!pw) {
            throw new Error("Playwright is required to import system profile cookies");
          }
          let injected = 0;
          if (decrypted.cookies.length > 0) {
            const tab = await profileCtx.ensureTabAvailable(undefined, {
              allowPlaywrightFallback: true,
              signal,
            });
            try {
              const result = await pw.cookiesSetManyViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                targetId: tab.targetId,
                cookies: decrypted.cookies,
                signal,
              });
              signal.throwIfAborted();
              injected = result.added;
            } catch {
              // Session/CDP errors may include rejected cookie payloads. Keep decrypted values private.
              throw new Error(`failed to inject imported cookies into managed profile "${into}"`);
            }
          }
          // Cookies rejected by Playwright are counted, not fatal: the import stays
          // best-effort and imported reflects what actually landed in the profile.
          const rejected = decrypted.cookies.length - injected;
          const result: ImportSystemProfileResult = {
            ok: true,
            systemProfile,
            into,
            browser,
            cookies: {
              total: decrypted.counts.total,
              imported: injected,
              failed: decrypted.counts.failed + rejected,
              skipped: decrypted.counts.skipped,
            },
            domains: decrypted.domains,
          };
          return result;
        },
        {
          commit: async (result) => await runtime.finalize?.(result),
        },
      );
    } catch (err) {
      if (isProfileRestartRequiredError(err)) {
        if (attempt === 0) {
          await profileCtx.ensureBrowserAvailable({ headless: true, signal: runtime.signal });
          continue;
        }
        throw new BrowserProfileUnavailableError(
          `Managed profile "${into}" could not stabilize for cookie import.`,
        );
      }
      throw err;
    }
  }
  throw new Error(`managed profile "${into}" could not stabilize for cookie import`);
}
