/**
 * OpenClaw-managed Chrome lifecycle and CDP helpers.
 *
 * Builds launch args, starts/stops managed Chrome, probes CDP readiness, and
 * resolves WebSocket endpoints for browser control.
 */
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
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
import { createBoundedUtf8Tail } from "./bounded-utf8-tail.js";
import { hasChromeProxyControlArg, omitChromeProxyEnv } from "./browser-proxy-mode.js";
import { assertManagedProxyAllowsCdpUrl } from "./cdp-proxy-bypass.js";
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
  scopeCdpPolicyToConfiguredEndpoint,
  withCdpSocket,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import {
  type ChromeCdpDiagnostic,
  diagnoseChromeCdp,
  formatChromeCdpDiagnostic,
  type ChromeVersion,
  readChromeVersionWithCredentialFallback,
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
  usesOpenClawMockKeychain,
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
import { BROWSER_ERROR_REASONS, BrowserProfileUnavailableError } from "./errors.js";
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
const CHROME_GRACEFUL_CLOSE_COMMAND_TIMEOUT_MS = 500;
const CHROME_LAUNCH_STDERR_TAIL_MAX_BYTES = 64 * 1024;
const CHROME_STDERR_MARKER_SCAN_TAIL_CHARS = 256;
const CHROME_HTTP_DISCOVERY_FAILURE_CODES = new Set([
  "ssrf_blocked",
  "http_unreachable",
  "http_status_failed",
  "invalid_json",
]);
const TCP_LISTEN_STATE_HEX = "0A";

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

function diagnosticShowsChromeHttpDiscovery(diagnostic: ChromeCdpDiagnostic | null): boolean {
  if (!diagnostic) {
    return false;
  }
  if (diagnostic.ok) {
    return true;
  }
  return !CHROME_HTTP_DISCOVERY_FAILURE_CODES.has(diagnostic.code);
}

type ChromeLaunchStderrSignals = {
  singletonInUse: boolean;
  missingDisplay: boolean;
};

function createChromeLaunchStderrDiagnostics(maxBytes: number) {
  const tail = createBoundedUtf8Tail(maxBytes);
  const signals: ChromeLaunchStderrSignals = {
    singletonInUse: false,
    missingDisplay: false,
  };
  let markerScanTail = "";

  const updateSignals = (chunkText: string) => {
    const scanText = `${markerScanTail}${chunkText}`;
    signals.singletonInUse ||= CHROME_SINGLETON_IN_USE_PATTERN.test(scanText);
    signals.missingDisplay ||= CHROME_MISSING_DISPLAY_PATTERN.test(scanText);
    markerScanTail = scanText.slice(-CHROME_STDERR_MARKER_SCAN_TAIL_CHARS);
  };

  return {
    append(chunk: Buffer | string) {
      tail.append(chunk);
      const chunkText = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (chunkText.length > 0) {
        updateSignals(chunkText);
      }
    },
    toString() {
      return tail.text();
    },
    signals(): ChromeLaunchStderrSignals {
      return { ...signals };
    },
    clear() {
      tail.clear();
      signals.singletonInUse = false;
      signals.missingDisplay = false;
      markerScanTail = "";
    },
  };
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

function readSingletonLockTarget(userDataDir: string): { hostname: string; pid: number } | null {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(userDataDir, "SingletonLock"));
  } catch {
    return null;
  }
  const match = /^(?<lockHost>.+)-(?<pid>\d+)$/.exec(target);
  if (!match?.groups) {
    return null;
  }
  const hostname = normalizeOptionalString(match.groups.lockHost) ?? "";
  const pid = Number.parseInt(match.groups.pid ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return { hostname, pid };
}

function readLinuxProcessStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const afterCommand = stat.slice(stat.lastIndexOf(")") + 2);
  const fields = afterCommand.split(/\s+/);
  return normalizeOptionalString(fields[19]) ?? null;
}

function readLinuxProcessArgv(pid: number): string[] | null {
  let cmdline: Buffer;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return null;
  }
  const argv = cmdline
    .toString("utf8")
    .split("\0")
    .filter((arg) => arg.length > 0);
  return argv.length > 0 ? argv : null;
}

function readPsCommandLine(pid: number): string | null {
  try {
    return (
      normalizeOptionalString(
        execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 1000,
          maxBuffer: 64 * 1024,
        }),
      ) ?? null
    );
  } catch {
    return null;
  }
}

function readPsStartTime(pid: number): string | null {
  try {
    return (
      normalizeOptionalString(
        execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 1000,
          maxBuffer: 64 * 1024,
        }),
      ) ?? null
    );
  } catch {
    return null;
  }
}

function readManagedProcessCommandLine(pid: number): {
  argv: string[] | null;
  text: string;
  startTime: string | null;
} | null {
  if (process.platform === "linux") {
    const argv = readLinuxProcessArgv(pid);
    if (!argv) {
      return null;
    }
    const startTime = readLinuxProcessStartTime(pid);
    if (!startTime) {
      return null;
    }
    return {
      argv,
      text: argv.join(" "),
      startTime,
    };
  }
  if (process.platform === "darwin") {
    const text = readPsCommandLine(pid);
    const startTime = readPsStartTime(pid);
    if (!text || !startTime) {
      return null;
    }
    return { argv: null, text, startTime };
  }
  return null;
}

function isChromeExecutableFamilyMatch(commandText: string, exe: BrowserExecutable): boolean {
  const normalizedCommand = commandText.toLowerCase();
  const configuredPath = exe.path.toLowerCase();
  const configuredBase = path.basename(exe.path).toLowerCase();
  if (
    normalizedCommand.includes(configuredPath) ||
    (configuredBase.length > 0 && normalizedCommand.includes(configuredBase))
  ) {
    return true;
  }
  if (exe.kind === "chrome" || exe.kind === "canary") {
    return /\b(google chrome|google-chrome|chrome|chromium)\b/i.test(commandText);
  }
  if (exe.kind === "chromium") {
    return /\b(chromium|chromium-browser)\b/i.test(commandText);
  }
  if (exe.kind === "brave") {
    return /\b(brave browser|brave-browser|brave)\b/i.test(commandText);
  }
  if (exe.kind === "edge") {
    return /\b(microsoft edge|microsoft-edge|msedge)\b/i.test(commandText);
  }
  return false;
}

function processCommandHasArg(
  command: { argv: string[] | null; text: string },
  expected: string,
): boolean {
  if (command.argv) {
    return command.argv.includes(expected);
  }
  return command.text.includes(expected);
}

function commandLineMatchesManagedChrome(params: {
  command: { argv: string[] | null; text: string };
  exe: BrowserExecutable;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
}): boolean {
  return (
    isChromeExecutableFamilyMatch(params.command.text, params.exe) &&
    processCommandHasArg(params.command, `--remote-debugging-port=${params.profile.cdpPort}`) &&
    processCommandHasArg(params.command, `--user-data-dir=${params.userDataDir}`)
  );
}

function parseLinuxTcpListenInodesForPort(table: string, port: number): Set<string> {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const line of table.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    const localAddress = fields[1] ?? "";
    const state = fields[3] ?? "";
    const inode = fields[9] ?? "";
    const localPort = localAddress.split(":").at(-1)?.toUpperCase();
    if (localPort === expectedPort && state === TCP_LISTEN_STATE_HEX && inode) {
      inodes.add(inode);
    }
  }
  return inodes;
}

function readLinuxTcpListenInodesForPort(port: number): Set<string> {
  const inodes = new Set<string>();
  for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const inode of parseLinuxTcpListenInodesForPort(
        fs.readFileSync(tablePath, "utf8"),
        port,
      )) {
        inodes.add(inode);
      }
    } catch {
      // Missing proc tables mean this platform cannot prove listener ownership.
    }
  }
  return inodes;
}

function linuxPidOwnsAnySocketInode(pid: number, inodes: Set<string>): boolean {
  if (inodes.size === 0) {
    return false;
  }
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const descriptor of descriptors) {
    let target: string;
    try {
      target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
    } catch {
      continue;
    }
    const match = /^socket:\[(?<inode>\d+)\]$/.exec(target);
    if (match?.groups?.inode && inodes.has(match.groups.inode)) {
      return true;
    }
  }
  return false;
}

function linuxPidListensOnPort(pid: number, port: number): boolean {
  return linuxPidOwnsAnySocketInode(pid, readLinuxTcpListenInodesForPort(port));
}

function lsofShowsPidListeningOnPort(pid: number, port: number): boolean {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024 },
    );
    return output.split(/\r?\n/).some((line) => line === `p${pid}`);
  } catch {
    return false;
  }
}

function pidListensOnPort(pid: number, port: number): boolean {
  if (process.platform === "linux") {
    return linuxPidListensOnPort(pid, port);
  }
  if (process.platform === "darwin") {
    return lsofShowsPidListeningOnPort(pid, port);
  }
  return false;
}

type ManagedChromeProcessIdentity = {
  pid: number;
  startTime: string | null;
  commandLine: string;
};

function sameManagedChromeIdentity(
  a: ManagedChromeProcessIdentity,
  b: ManagedChromeProcessIdentity,
): boolean {
  return a.pid === b.pid && a.commandLine === b.commandLine && a.startTime === b.startTime;
}

function readOwnedManagedChromeIdentity(params: {
  pid: number;
  exe: BrowserExecutable;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
}): ManagedChromeProcessIdentity | null {
  if (!processExists(params.pid) || !pidListensOnPort(params.pid, params.profile.cdpPort)) {
    return null;
  }
  const command = readManagedProcessCommandLine(params.pid);
  if (
    !command ||
    !commandLineMatchesManagedChrome({
      command,
      exe: params.exe,
      profile: params.profile,
      userDataDir: params.userDataDir,
    })
  ) {
    return null;
  }
  return {
    pid: params.pid,
    startTime: command.startTime,
    commandLine: command.text,
  };
}

function isPortInUseError(err: unknown): boolean {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    errno === "EADDRINUSE" ||
    name === "PortInUseError" ||
    /\bEADDRINUSE\b|already in use/i.test(message)
  );
}

function readCurrentHostSingletonPid(userDataDir: string, hostname = os.hostname()): number | null {
  const lock = readSingletonLockTarget(userDataDir);
  if (!lock || lock.hostname !== hostname || !processExists(lock.pid)) {
    return null;
  }
  return lock.pid;
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

/** Remove stale Chrome singleton lock files from a user-data-dir. */
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

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CHROME_BOOTSTRAP_EXIT_POLL_MS);
    });
  }
  return !processExists(pid);
}

async function terminateOwnedStaleChromeProcess(
  params: {
    identity: ManagedChromeProcessIdentity;
    exe: BrowserExecutable;
    profile: ResolvedBrowserProfile;
    userDataDir: string;
  },
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
): Promise<boolean> {
  const readCurrentIdentity = () =>
    readOwnedManagedChromeIdentity({
      pid: params.identity.pid,
      exe: params.exe,
      profile: params.profile,
      userDataDir: params.userDataDir,
    });
  const beforeSigterm = readCurrentIdentity();
  if (!beforeSigterm || !sameManagedChromeIdentity(params.identity, beforeSigterm)) {
    return false;
  }
  try {
    process.kill(params.identity.pid, "SIGTERM");
  } catch {
    return false;
  }
  if (await waitForPidExit(params.identity.pid, timeoutMs)) {
    return true;
  }
  const beforeSigkill = readCurrentIdentity();
  if (!beforeSigkill || !sameManagedChromeIdentity(params.identity, beforeSigkill)) {
    return false;
  }
  try {
    process.kill(params.identity.pid, "SIGKILL");
  } catch {
    return false;
  }
  return await waitForPidExit(params.identity.pid, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
}

function clearRecoveredChromeSingletonArtifacts(userDataDir: string, pid: number): boolean {
  const lock = readSingletonLockTarget(userDataDir);
  if (!lock || lock.hostname !== os.hostname() || lock.pid !== pid || processExists(pid)) {
    return false;
  }
  clearChromeSingletonArtifacts(userDataDir);
  return true;
}

async function recoverOwnedStaleManagedChromeCdpListener(params: {
  exe: BrowserExecutable;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
}): Promise<boolean> {
  if (!params.profile.cdpIsLoopback) {
    return false;
  }
  const pid = readCurrentHostSingletonPid(params.userDataDir);
  if (pid == null) {
    return false;
  }
  let diagnostic: ChromeCdpDiagnostic;
  try {
    diagnostic = await diagnoseChromeCdp(
      params.profile.cdpUrl,
      CHROME_REACHABILITY_TIMEOUT_MS,
      CHROME_WS_READY_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
  if (diagnostic.ok || diagnostic.code !== "websocket_health_command_timeout") {
    return false;
  }
  const identity = readOwnedManagedChromeIdentity({
    pid,
    exe: params.exe,
    profile: params.profile,
    userDataDir: params.userDataDir,
  });
  if (!identity) {
    return false;
  }
  if (
    !(await terminateOwnedStaleChromeProcess({
      identity,
      exe: params.exe,
      profile: params.profile,
      userDataDir: params.userDataDir,
    }))
  ) {
    return false;
  }
  if (!clearRecoveredChromeSingletonArtifacts(params.userDataDir, pid)) {
    return false;
  }
  log.warn(
    `Stopped stale managed Chrome CDP listener for profile "${params.profile.name}" (pid ${pid}) and retrying launch.`,
  );
  return true;
}

async function ensureManagedChromePortAvailable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  userDataDir: string,
): Promise<void> {
  const configuredHost = new URL(profile.cdpUrl).hostname.replace(/^\[|\]$/g, "");
  const probeHosts =
    configuredHost === "127.0.0.1" ? [configuredHost] : ["127.0.0.1", configuredHost];
  const ensureProbeHostsAvailable = async () => {
    for (const host of probeHosts) {
      await ensurePortAvailable(profile.cdpPort, host);
    }
  };

  // Chromium tries IPv4 loopback first, while OpenClaw polls the configured endpoint.
  // Probe both so neither Chrome's bind nor the later readiness check can be captured.
  try {
    await ensureProbeHostsAvailable();
    return;
  } catch (err) {
    const exe = resolveBrowserExecutable(resolved, profile);
    if (!isPortInUseError(err) || !exe) {
      throw err;
    }
    if (!(await recoverOwnedStaleManagedChromeCdpListener({ exe, profile, userDataDir }))) {
      throw err;
    }
  }
  await ensureProbeHostsAvailable();
}

function chromeLaunchHints(params: {
  stderrOutput: string;
  stderrSignals?: ChromeLaunchStderrSignals;
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
  const missingDisplay =
    params.stderrSignals?.missingDisplay ??
    CHROME_MISSING_DISPLAY_PATTERN.test(params.stderrOutput);
  if (missingDisplay && !headlessMode.headless) {
    hints.push(
      "No DISPLAY/X server was detected. Set OPENCLAW_BROWSER_HEADLESS=1, remove the headed override, start Xvfb, or run the Gateway in a desktop session.",
    );
  }
  const singletonInUse =
    params.stderrSignals?.singletonInUse ??
    CHROME_SINGLETON_IN_USE_PATTERN.test(params.stderrOutput);
  if (singletonInUse) {
    hints.push(
      `The Chromium profile "${params.profile.name}" is locked. Stop the existing browser or remove stale Singleton* lock files under ~/.openclaw/browser/${params.profile.name}/user-data.`,
    );
  }
  return hints.length > 0 ? `\nHint: ${hints.join("\nHint: ")}` : "";
}

/** Running managed Chrome process and resolved control metadata. */
export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcess;
  headless?: boolean;
  headlessSource?: ManagedBrowserHeadlessSource;
  /**
   * @deprecated CDP managed-proxy bypasses are scoped at exact request URLs.
   * Kept so older in-memory callers can pass stale RunningChrome objects
   * through stopOpenClawChrome without type churn.
   */
  releaseCdpProxyBypass?: () => void;
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

/** Resolve the user-data-dir path for a managed OpenClaw Chrome profile. */
export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

/** Build Chrome launch arguments for the managed OpenClaw browser. */
export function buildOpenClawChromeLaunchArgs(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  headlessOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  useMockKeychain?: boolean;
}): string[] {
  const { resolved, profile, userDataDir } = params;
  const platform = params.platform ?? process.platform;
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

  if (platform === "darwin" && params.useMockKeychain) {
    // This is an isolated OpenClaw-owned profile, not the user's Chrome profile.
    // Keep its basic password store non-interactive so headless Chrome can
    // encrypt and persist cookies without login-keychain prompts.
    args.push("--use-mock-keychain");
  }
  if (headlessMode.headless) {
    args.push("--headless=new");
    args.push("--disable-gpu");
  }
  if (resolved.noSandbox) {
    args.push("--no-sandbox");
  }
  if (platform === "linux") {
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

/** Return true when a Chrome CDP endpoint is reachable over HTTP. */
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
    return await readChromeVersionWithCredentialFallback(cdpUrl, timeoutMs, ssrfPolicy);
  } catch {
    return null;
  }
}

/** Resolve a usable Chrome DevTools WebSocket URL from a CDP endpoint. */
export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<string | null> {
  await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(cdpUrl, ssrfPolicy);
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
  const version = await fetchChromeVersion(discoveryUrl, timeoutMs, cdpControlPolicy);
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
  await assertCdpEndpointAllowed(normalizedWsUrl, cdpControlPolicy, {
    source: "discovered",
    configuredUrl: cdpUrl,
  });
  return normalizedWsUrl;
}

/** Return true when a Chrome CDP endpoint has a healthy WebSocket command path. */
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

/** Launch or attach to the managed OpenClaw Chrome profile. */
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
    throw new BrowserProfileUnavailableError(missingDisplayError.message, {
      metadata: {
        reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
        details: {
          profile: profile.name,
          requestedHeadless: false,
          headlessSource: missingDisplayError.headlessSource,
          displayPresent: false,
        },
      },
    });
  }

  // Surface `loopbackMode=block` before spawning Chrome. The CDP fetch and
  // WebSocket helpers install exact-URL bypasses for `/json/version` and
  // `ws://.../devtools/...`.
  try {
    assertManagedProxyAllowsCdpUrl(profile.cdpUrl);
  } catch (err) {
    throw new BrowserProfileUnavailableError(
      `Browser profile "${profile.name}" cannot launch: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  await ensureManagedChromePortAvailable(resolved, profile, userDataDir);

  const exe = resolveBrowserExecutable(resolved, profile);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const profileIsNew = !exists(localStatePath);
  const needsBootstrap = profileIsNew || !exists(preferencesPath);
  // Never change the encryption key source for an established profile: doing
  // so would make its existing cookies unreadable. New headless profiles opt in.
  const useMockKeychain =
    process.platform === "darwin" &&
    (usesOpenClawMockKeychain(userDataDir) || (profileIsNew && headlessMode.headless));

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
      useMockKeychain,
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

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => {
        setTimeout(r, CHROME_BOOTSTRAP_PREFS_POLL_MS);
      });
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
      await new Promise((r) => {
        setTimeout(r, CHROME_BOOTSTRAP_EXIT_POLL_MS);
      });
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
        downloadDir: DEFAULT_DOWNLOAD_DIR,
        mockKeychain: useMockKeychain,
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

    // Keep a bounded stderr tail for diagnostics in case Chrome fails to start.
    // The listener is removed on success to avoid retaining output from a
    // long-lived Chrome process that emits periodic warnings.
    const stderrDiagnostics = createChromeLaunchStderrDiagnostics(
      CHROME_LAUNCH_STDERR_TAIL_MAX_BYTES,
    );
    const onStderr = (chunk: Buffer | string) => {
      stderrDiagnostics.append(chunk);
    };
    proc.stderr?.on("data", onStderr);

    try {
      const readyDeadline =
        Date.now() + (resolved.localLaunchTimeoutMs ?? CHROME_LAUNCH_READY_WINDOW_MS);
      let launchHttpReachable = false;
      // Full CDP WebSocket readiness is handled by the caller's
      // waitForCdpReadyAfterLaunch() budget; launch only owns process discovery.
      while (Date.now() < readyDeadline) {
        if (await isChromeReachable(profile.cdpUrl)) {
          launchHttpReachable = true;
          break;
        }
        await new Promise((r) => {
          setTimeout(r, CHROME_LAUNCH_READY_POLL_MS);
        });
      }

      if (!launchHttpReachable) {
        let finalDiagnostic: ChromeCdpDiagnostic | null = null;
        let diagnosticErrorText: string | null = null;
        try {
          finalDiagnostic = await diagnoseChromeCdp(
            profile.cdpUrl,
            CHROME_REACHABILITY_TIMEOUT_MS,
            CHROME_WS_READY_TIMEOUT_MS,
          );
        } catch (err) {
          diagnosticErrorText = `CDP diagnostic failed: ${safeChromeCdpErrorMessage(err)}.`;
        }
        if (diagnosticShowsChromeHttpDiscovery(finalDiagnostic)) {
          launchHttpReachable = true;
        }
        const diagnosticText = finalDiagnostic
          ? formatChromeCdpDiagnostic(finalDiagnostic)
          : (diagnosticErrorText ?? "CDP diagnostic failed.");
        if (launchHttpReachable) {
          log.debug(diagnosticText);
        } else {
          const stderrOutput = normalizeOptionalString(stderrDiagnostics.toString()) ?? "";
          const stderrSignals = stderrDiagnostics.signals();
          const redactedStderrOutput = redactToolPayloadText(stderrOutput);
          if (
            allowSingletonRecovery &&
            stderrSignals.singletonInUse &&
            clearStaleChromeSingletonLocks(userDataDir)
          ) {
            log.warn(
              `Removed stale Chromium Singleton* locks for profile "${profile.name}" and retrying launch.`,
            );
            await terminateChromeForRetry(proc, userDataDir);
            return await launchOnceAndWait(false);
          }
          const stderrHint = redactedStderrOutput
            ? `\nChrome stderr:\n${redactedStderrOutput.slice(-CHROME_STDERR_HINT_MAX_CHARS)}`
            : "";
          const launchHints = chromeLaunchHints({
            stderrOutput,
            stderrSignals,
            resolved,
            profile,
            launchOptions,
          });
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          throw new Error(
            `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}". ${diagnosticText}${launchHints}${stderrHint}`,
          );
        }
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
      // and release the bounded tail buffer.
      proc.stderr?.off("data", onStderr);
      stderrDiagnostics.clear();
    }
  };

  return await launchOnceAndWait(true);
}

async function requestGracefulChromeClose(cdpPort: number, timeoutMs: number): Promise<boolean> {
  const commandTimeoutMs = Math.max(
    1,
    Math.min(timeoutMs, CHROME_GRACEFUL_CLOSE_COMMAND_TIMEOUT_MS),
  );
  let commandSent = false;
  try {
    const wsUrl = await getChromeWebSocketUrl(
      cdpUrlForPort(cdpPort),
      Math.min(commandTimeoutMs, CHROME_STOP_PROBE_TIMEOUT_MS),
    );
    if (!wsUrl) {
      return false;
    }
    await withCdpSocket(
      wsUrl,
      async (send) => {
        commandSent = true;
        await send("Browser.close");
      },
      {
        commandTimeoutMs,
        handshakeTimeoutMs: commandTimeoutMs,
        handshakeRetries: 0,
      },
    );
    return true;
  } catch (err) {
    log.debug(`Chrome graceful close skipped: ${safeChromeCdpErrorMessage(err)}`);
    // Chrome may close the socket before acknowledging Browser.close. Once the
    // command was sent, still give it time to flush the profile and exit.
    return commandSent;
  }
}

async function waitForChromeCdpShutdown(cdpPort: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isChromeReachable(cdpUrlForPort(cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS))) {
      return true;
    }
    const remainingMs = timeoutMs - (Date.now() - start);
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(1, Math.min(100, remainingMs)));
    });
  }
  return !(await isChromeReachable(cdpUrlForPort(cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS));
}

/** Stop a managed Chrome process and wait for shutdown. */
export async function stopOpenClawChrome(
  running: RunningChrome,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
) {
  const proc = running.proc;
  try {
    // The fixed CDP port may already belong to a replacement. Once the
    // tracked child exits, never send Browser.close to the current listener.
    if (proc.killed || proc.exitCode != null || proc.signalCode != null) {
      return;
    }

    // Gateway shutdown/restart awaits the Browser plugin stop chain into this
    // method. Browser.close keeps cookies in Chromium's protected profile;
    // signals remain a bounded fallback without duplicating credentials.
    const gracefulCloseRequested = await requestGracefulChromeClose(running.cdpPort, timeoutMs);
    if (gracefulCloseRequested && (await waitForChromeCdpShutdown(running.cdpPort, timeoutMs))) {
      return;
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    if (await waitForChromeCdpShutdown(running.cdpPort, timeoutMs)) {
      return;
    }

    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  } finally {
    // Release the managed-proxy bypass we registered at launch time. Wrapped
    // in try/catch + nulled out so a double-stop is a no-op and a failing
    // release does not mask a teardown error.
    const release = running.releaseCdpProxyBypass;
    if (release) {
      running.releaseCdpProxyBypass = undefined;
      try {
        release();
      } catch {
        // best-effort; the bypass survives until process exit at worst
      }
    }
  }
}
