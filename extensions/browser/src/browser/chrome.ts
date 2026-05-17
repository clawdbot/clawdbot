import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareOomScoreAdjustedSpawn } from "openclaw/plugin-sdk/process-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ensurePortAvailable } from "../infra/ports.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { hasChromeProxyControlArg, omitChromeProxyEnv } from "./browser-proxy-mode.js";
import {
  CHROME_BOOTSTRAP_EXIT_POLL_MS,
  CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS,
  CHROME_BOOTSTRAP_PREFS_POLL_MS,
  CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS,
  CHROME_LAUNCH_READY_POLL_MS,
  CHROME_LAUNCH_READY_WINDOW_MS,
  CHROME_REACHABILITY_TIMEOUT_MS,
  CHROME_STDERR_HINT_MAX_CHARS,
  CHROME_STOP_PROBE_TIMEOUT_MS,
  CHROME_STOP_TIMEOUT_MS,
  CHROME_WS_READY_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import {
  assertCdpEndpointAllowed,
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  openCdpWebSocket,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import {
  diagnoseChromeCdp,
  formatChromeCdpDiagnostic,
  type ChromeVersion,
  readChromeVersion,
  safeChromeCdpErrorMessage,
} from "./chrome.diagnostics.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import {
  getManagedBrowserMissingDisplayError,
  resolveManagedBrowserHeadlessMode,
  type ManagedBrowserHeadlessOptions,
  type ManagedBrowserHeadlessSource,
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
} from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import { ensureOutputDirectory } from "./output-directories.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";

const log = createSubsystemLogger("browser").child("chrome");
const CHROME_SINGLETON_LOCK_PATHS = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;
const CHROME_SINGLETON_IN_USE_PATTERN = /profile appears to be in use by another chromium process/i;
const CHROME_MISSING_DISPLAY_PATTERN = /missing x server|\$DISPLAY/i;

export type { BrowserExecutable } from "./chrome.executables.js";
export {
  diagnoseChromeCdp,
  formatChromeCdpDiagnostic,
  type ChromeCdpDiagnostic,
  type ChromeCdpDiagnosticCode,
} from "./chrome.diagnostics.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function clearChromeSingletonArtifacts(userDataDir: string) {
  for (const basename of CHROME_SINGLETON_LOCK_PATHS) {
    try {
      fs.rmSync(path.join(userDataDir, basename), { force: true });
    } catch {
      // ignore best-effort cleanup
    }
  }
}

export function clearStaleChromeSingletonLocks(
  userDataDir: string,
  hostname = os.hostname(),
): boolean {
  const lockPath = path.join(userDataDir, "SingletonLock");
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return false;
  }

  const match = /^(?<lockHost>.+)-(?<pid>\d+)$/.exec(target);
  if (!match?.groups) {
    return false;
  }

  const lockHost = normalizeOptionalString(match.groups.lockHost) ?? "";
  const pid = Number.parseInt(match.groups.pid ?? "", 10);
  if (lockHost === hostname && processExists(pid)) {
    return false;
  }

  clearChromeSingletonArtifacts(userDataDir);
  return true;
}

async function waitForChromeProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null || proc.killed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      proc.off("close", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    proc.once("exit", onExit);
    proc.once("close", onExit);
  });
}

async function terminateChromeForRetry(proc: ChildProcess, userDataDir: string) {
  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
  await waitForChromeProcessExit(proc, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
  clearStaleChromeSingletonLocks(userDataDir);
}

function chromeLaunchHints(params: {
  stderrOutput: string;
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  launchOptions?: ManagedBrowserHeadlessOptions;
}): string {
  const hints: string[] = [];
  if (process.platform === "linux" && !params.resolved.noSandbox) {
    hints.push("If running in a container or as root, try setting browser.noSandbox: true.");
  }
  const headlessMode = resolveManagedBrowserHeadlessMode(
    params.resolved,
    params.profile,
    params.launchOptions,
  );
  if (CHROME_MISSING_DISPLAY_PATTERN.test(params.stderrOutput) && !headlessMode.headless) {
    hints.push(
      "No DISPLAY/X server was detected. Set OPENCLAW_BROWSER_HEADLESS=1, remove the headed override, start Xvfb, or run the Gateway in a desktop session.",
    );
  }
  if (CHROME_SINGLETON_IN_USE_PATTERN.test(params.stderrOutput)) {
    hints.push(
      `The Chromium profile "${params.profile.name}" is locked. Stop the existing browser or remove stale Singleton* lock files under ~/.openclaw/browser/${params.profile.name}/user-data.`,
    );
  }
  return hints.length > 0 ? `\nHint: ${hints.join("\nHint: ")}` : "";
}

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcess;
  headless?: boolean;
  headlessSource?: ManagedBrowserHeadlessSource;
};

function resolveBrowserExecutable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(
    { ...resolved, executablePath: profile.executablePath ?? resolved.executablePath },
    process.platform,
  );
}

export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

export function buildOpenClawChromeLaunchArgs(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  headlessOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string[] {
  const { resolved, profile, userDataDir } = params;
  const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, params);
  const args: string[] = [
    `--remote-debugging-port=${profile.cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
  ];

  if (headlessMode.headless) {
    args.push("--headless=new");
    args.push("--disable-gpu");
  }
  if (resolved.noSandbox) {
    args.push("--no-sandbox");
  }
  if (process.platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  if (!hasChromeProxyControlArg(resolved.extraArgs)) {
    args.push("--no-proxy-server");
  }
  if (resolved.extraArgs.length > 0) {
    args.push(...resolved.extraArgs);
  }

  return args;
}

async function canOpenWebSocket(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ws = openCdpWebSocket(url, { handshakeTimeoutMs: timeoutMs });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    ws.once("open", () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      finish(true);
    });
    ws.once("error", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<boolean> {
  try {
    await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
    if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
      // Handshake-ready direct WS endpoint — probe via WS handshake.
      return await canOpenWebSocket(cdpUrl, timeoutMs);
    }
    // Either an http(s) discovery URL or a bare ws/wss root. Try
    // /json/version discovery first. For bare ws/wss URLs, fall back to a
    // direct WS handshake when discovery is unavailable — some providers
    // (e.g. Browserless/Browserbase) expose a direct WebSocket root without
    // a /json/version endpoint.
    const discoveryUrl = isWebSocketUrl(cdpUrl)
      ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl)
      : cdpUrl;
    const version = await fetchChromeVersion(discoveryUrl, timeoutMs, ssrfPolicy);
    if (version) {
      return true;
    }
    if (isWebSocketUrl(cdpUrl)) {
      return await canOpenWebSocket(cdpUrl, timeoutMs);
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<ChromeVersion | null> {
  try {
    return await readChromeVersion(cdpUrl, timeoutMs, ssrfPolicy);
  } catch {
    return null;
  }
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<string | null> {
  await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
    // Handshake-ready direct WebSocket endpoint — the cdpUrl is already
    // the WebSocket URL.
    return cdpUrl;
  }
  // Either an http(s) endpoint or a bare ws/wss root; discover the
  // actual WebSocket URL via /json/version. Normalise the scheme so
  // fetch() can reach the endpoint.
  const discoveryUrl = isWebSocketUrl(cdpUrl)
    ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl)
    : cdpUrl;
  const version = await fetchChromeVersion(discoveryUrl, timeoutMs, ssrfPolicy);
  const wsUrl = normalizeOptionalString(version?.webSocketDebuggerUrl) ?? "";
  if (!wsUrl) {
    // /json/version unavailable or returned no WebSocket URL. For bare
    // ws/wss inputs, the URL itself may be a direct WebSocket endpoint
    // (e.g. Browserless/Browserbase-style providers without /json/version).
    // The SSRF check on cdpUrl was already performed at the start of this
    // function, so we can return it directly.
    if (isWebSocketUrl(cdpUrl)) {
      return cdpUrl;
    }
    return null;
  }
  const normalizedWsUrl = normalizeCdpWsUrl(wsUrl, discoveryUrl);
  await assertCdpEndpointAllowed(normalizedWsUrl, ssrfPolicy);
  return normalizedWsUrl;
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<boolean> {
  const diagnostic = await diagnoseChromeCdp(cdpUrl, timeoutMs, handshakeTimeoutMs, ssrfPolicy);
  if (!diagnostic.ok) {
    log.debug(formatChromeCdpDiagnostic(diagnostic));
  }
  return diagnostic.ok;
}

export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  launchOptions: ManagedBrowserHeadlessOptions = {},
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, launchOptions);
  const missingDisplayError = getManagedBrowserMissingDisplayError(
    resolved,
    profile,
    launchOptions,
  );
  if (missingDisplayError) {
    throw new BrowserProfileUnavailableError(missingDisplayError);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved, profile);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });
  await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
    DEFAULT_DOWNLOAD_DIR,
  );

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args = buildOpenClawChromeLaunchArgs({
      resolved,
      profile,
      userDataDir,
      ...launchOptions,
    });
    const env: NodeJS.ProcessEnv = {
      ...omitChromeProxyEnv(process.env),
      // Reduce accidental sharing with the user's env.
      HOME: os.homedir(),
    };
    if (process.platform === "linux") {
      const chromiumStateDir = path.join(resolvePreferredOpenClawTmpDir(), ".chromium");
      env.XDG_CONFIG_HOME ??= chromiumStateDir;
      env.XDG_CACHE_HOME ??= chromiumStateDir;
    }
    // stdio tuple: discard stdout to prevent buffer saturation in constrained
    // environments (e.g. Docker), while keeping stderr piped for diagnostics.
    // Cast to ChildProcessWithoutNullStreams so callers can use .stderr safely;
    // the tuple overload resolution varies across @types/node versions.
    const preparedSpawn = prepareOomScoreAdjustedSpawn(exe.path, args, {
      env,
    });
    return spawn(preparedSpawn.command, preparedSpawn.args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: preparedSpawn.env,
    }) as unknown as ChildProcessWithoutNullStreams;
  };

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, CHROME_BOOTSTRAP_PREFS_POLL_MS));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((r) => setTimeout(r, CHROME_BOOTSTRAP_EXIT_POLL_MS));
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
        downloadDir: DEFAULT_DOWNLOAD_DIR,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }

  const launchOnceAndWait = async (allowSingletonRecovery: boolean): Promise<RunningChrome> => {
    const proc = spawnOnce();

    // Collect stderr for diagnostics in case Chrome fails to start.
    // The listener is removed on success to avoid unbounded memory growth
    // from a long-lived Chrome process that emits periodic warnings.
    const stderrChunks: Buffer[] = [];
    const onStderr = (chunk: Buffer) => {
      stderrChunks.push(chunk);
    };
    proc.stderr?.on("data", onStderr);

    try {
      const readyDeadline =
        Date.now() + (resolved.localLaunchTimeoutMs ?? CHROME_LAUNCH_READY_WINDOW_MS);
      while (Date.now() < readyDeadline) {
        if (await isChromeReachable(profile.cdpUrl)) {
          break;
        }
        await new Promise((r) => setTimeout(r, CHROME_LAUNCH_READY_POLL_MS));
      }

      if (!(await isChromeReachable(profile.cdpUrl))) {
        const diagnosticText = await diagnoseChromeCdp(profile.cdpUrl)
          .then(formatChromeCdpDiagnostic)
          .catch((err) => `CDP diagnostic failed: ${safeChromeCdpErrorMessage(err)}.`);
        const stderrOutput =
          normalizeOptionalString(Buffer.concat(stderrChunks).toString("utf8")) ?? "";
        const redactedStderrOutput = redactToolPayloadText(stderrOutput);
        if (
          allowSingletonRecovery &&
          CHROME_SINGLETON_IN_USE_PATTERN.test(stderrOutput) &&
          clearStaleChromeSingletonLocks(userDataDir)
        ) {
          log.warn(
            `Removed stale Chromium Singleton* locks for profile "${profile.name}" and retrying launch.`,
          );
          await terminateChromeForRetry(proc, userDataDir);
          return await launchOnceAndWait(false);
        }
        const stderrHint = redactedStderrOutput
          ? `\nChrome stderr:\n${redactedStderrOutput.slice(0, CHROME_STDERR_HINT_MAX_CHARS)}`
          : "";
        const launchHints = chromeLaunchHints({ stderrOutput, resolved, profile, launchOptions });
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        throw new Error(
          `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}". ${diagnosticText}${launchHints}${stderrHint}`,
        );
      }

      const pid = proc.pid ?? -1;
      log.info(
        `🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
      );

      return {
        pid,
        exe,
        userDataDir,
        cdpPort: profile.cdpPort,
        startedAt,
        proc,
        headless: headlessMode.headless,
        headlessSource: headlessMode.source,
      };
    } finally {
      // Chrome started successfully or launch failed — detach the stderr listener
      // and release the buffer.
      proc.stderr?.off("data", onStderr);
      stderrChunks.length = 0;
    }
  };

  return await launchOnceAndWait(true);
}

export async function stopOpenClawChrome(
  running: RunningChrome,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
) {
  const proc = running.proc;
  if (proc.killed) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) {
      break;
    }
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS))) {
      return;
    }
    const remainingMs = timeoutMs - (Date.now() - start);
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(100, remainingMs))));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
