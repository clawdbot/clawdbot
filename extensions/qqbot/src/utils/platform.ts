/**
 * Cross-platform compatibility helpers.
 *
 * This module centralizes home/temp directory discovery, local-path checks,
 * ffmpeg/ffprobe lookup, native-module compatibility checks, and startup diagnostics.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { debugLog, debugWarn } from "./debug-log.js";

// Basic platform information.

export type PlatformType = "darwin" | "linux" | "win32" | "other";

export function getPlatform(): PlatformType {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") {
    return p;
  }
  return "other";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

// Home directory helpers.

/**
 * Resolve the current user's home directory safely across platforms.
 *
 * Priority:
 * 1. `os.homedir()`
 * 2. `$HOME` or `%USERPROFILE%`
 * 3. the OpenClaw temp directory as a last resort
 */
export function getHomeDir(): string {
  try {
    const home = os.homedir();
    if (home && fs.existsSync(home)) {
      return home;
    }
  } catch {}

  // Fall back to environment variables.
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome && fs.existsSync(envHome)) {
    return envHome;
  }

  // Final fallback.
  return resolvePreferredOpenClawTmpDir();
}

/**
 * Return a path under `~/.openclaw/qqbot`, creating it on demand.
 */
export function getQQBotDataDir(...subPaths: string[]): string {
  const dir = path.join(getHomeDir(), ".openclaw", "qqbot", ...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Return a path under `~/.openclaw/media/qqbot`, creating it on demand.
 *
 * Unlike `getQQBotDataDir`, this lives under OpenClaw's core media allowlist so
 * downloaded images and audio can be accessed by framework media tooling.
 */
export function getQQBotMediaDir(...subPaths: string[]): string {
  const dir = path.join(getHomeDir(), ".openclaw", "media", "qqbot", ...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Temporary directory helpers.

/** Return the preferred OpenClaw temp directory. */
export function getTempDir(): string {
  return resolvePreferredOpenClawTmpDir();
}

// Tilde expansion.

/**
 * Expand `~` to the current user's home directory.
 *
 * Supports `~` and `~/...`. Other forms are returned unchanged.
 */
export function expandTilde(p: string): string {
  if (!p) {
    return p;
  }
  if (p === "~") {
    return getHomeDir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(getHomeDir(), p.slice(2));
  }
  return p;
}

/**
 * Normalize a user-provided path by trimming, stripping `file://`, and expanding `~`.
 */
export function normalizePath(p: string): string {
  let result = p.trim();
  // Strip the local file URI scheme.
  if (result.startsWith("file://")) {
    result = result.slice("file://".length);
    // Decode URL-escaped paths when possible.
    try {
      result = decodeURIComponent(result);
    } catch {
      // Keep the raw string if decoding fails.
    }
  }
  return expandTilde(result);
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Remap legacy or hallucinated QQ Bot local media paths to real files when possible.
 */
export function resolveQQBotLocalMediaPath(p: string): string {
  const normalized = normalizePath(p);
  if (!isLocalPath(normalized) || fs.existsSync(normalized)) {
    return normalized;
  }

  const homeDir = getHomeDir();
  const mediaRoot = getQQBotMediaDir();
  const dataRoot = getQQBotDataDir();
  const workspaceRoot = path.join(homeDir, ".openclaw", "workspace", "qqbot");
  const candidateRoots = [
    { from: workspaceRoot, to: mediaRoot },
    { from: dataRoot, to: mediaRoot },
    { from: mediaRoot, to: dataRoot },
  ];

  for (const { from, to } of candidateRoots) {
    if (!isPathWithinRoot(normalized, from)) {
      continue;
    }
    const relative = path.relative(from, normalized);
    const candidate = path.join(to, relative);
    if (fs.existsSync(candidate)) {
      debugWarn(`[platform] Remapped missing QQBot media path ${normalized} -> ${candidate}`);
      return candidate;
    }
  }

  return normalized;
}

/**
 * Resolve a structured-payload local file path and enforce that it stays within
 * QQ Bot-owned storage roots.
 */
export function resolveQQBotPayloadLocalFilePath(p: string): string | null {
  const candidate = resolveQQBotLocalMediaPath(p);
  if (!candidate.trim()) {
    return null;
  }

  const resolvedCandidate = path.resolve(candidate);
  if (!fs.existsSync(resolvedCandidate)) {
    return null;
  }

  const canonicalCandidate = fs.realpathSync(resolvedCandidate);
  const allowedRoots = [getQQBotMediaDir()];

  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    const canonicalRoot = fs.existsSync(resolvedRoot)
      ? fs.realpathSync(resolvedRoot)
      : resolvedRoot;
    if (isPathWithinRoot(canonicalCandidate, canonicalRoot)) {
      return canonicalCandidate;
    }
  }

  return null;
}

// Filename normalization.

/**
 * Normalize filenames into a UTF-8 form that the QQ Bot API accepts reliably.
 *
 * This decodes percent-escaped names, converts Unicode to NFC, and strips ASCII
 * control characters.
 */
export function sanitizeFileName(name: string): string {
  if (!name) {
    return name;
  }

  let result = name.trim();

  // Decode percent-escaped names when they came from URLs.
  if (result.includes("%")) {
    try {
      result = decodeURIComponent(result);
    } catch {
      // Keep the raw value if it is not valid percent-encoding.
    }
  }

  // Convert macOS-style NFD names into standard NFC form.
  result = result.normalize("NFC");

  // Drop ASCII control characters while keeping printable Unicode content.
  result = result.replace(/\p{Cc}/gu, "");

  return result;
}

// Local path detection.

/**
 * Return true when the string looks like a local filesystem path rather than a URL.
 */
export function isLocalPath(p: string): boolean {
  if (!p) {
    return false;
  }
  // Local file URI.
  if (p.startsWith("file://")) {
    return true;
  }
  // Tilde-based Unix path.
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return true;
  }
  // Unix absolute path.
  if (p.startsWith("/")) {
    return true;
  }
  // Windows drive-letter path.
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    return true;
  }
  // Windows UNC path.
  if (p.startsWith("\\\\")) {
    return true;
  }
  // POSIX relative path.
  if (p.startsWith("./") || p.startsWith("../")) {
    return true;
  }
  // Windows relative path.
  if (p.startsWith(".\\") || p.startsWith("..\\")) {
    return true;
  }
  return false;
}

/** Looser local-path heuristic used for markdown-extracted paths. */
export function looksLikeLocalPath(p: string): boolean {
  if (isLocalPath(p)) {
    return true;
  }
  return /^(?:Users|home|tmp|var|private|[A-Z]:)/i.test(p);
}

let _ffmpegPath: string | null | undefined;
let _ffmpegCheckPromise: Promise<string | null> | null = null;

/** Detect ffmpeg and return an executable path when available. */
export function detectFfmpeg(): Promise<string | null> {
  if (_ffmpegPath !== undefined) {
    return Promise.resolve(_ffmpegPath);
  }
  if (_ffmpegCheckPromise) {
    return _ffmpegCheckPromise;
  }

  _ffmpegCheckPromise = (async () => {
    const envPath = process.env.FFMPEG_PATH;
    if (envPath) {
      const ok = await testExecutable(envPath, ["-version"]);
      if (ok) {
        _ffmpegPath = envPath;
        debugLog(`[platform] ffmpeg found via FFMPEG_PATH: ${envPath}`);
        return _ffmpegPath;
      }
      debugWarn(`[platform] FFMPEG_PATH set but not working: ${envPath}`);
    }

    const cmd = isWindows() ? "ffmpeg.exe" : "ffmpeg";
    const ok = await testExecutable(cmd, ["-version"]);
    if (ok) {
      _ffmpegPath = cmd;
      debugLog(`[platform] ffmpeg detected in PATH`);
      return _ffmpegPath;
    }

    const commonPaths = isWindows()
      ? [
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
          path.join(process.env.LOCALAPPDATA || "", "Programs", "ffmpeg", "bin", "ffmpeg.exe"),
          path.join(process.env.ProgramFiles || "", "ffmpeg", "bin", "ffmpeg.exe"),
        ]
      : [
          "/usr/local/bin/ffmpeg",
          "/opt/homebrew/bin/ffmpeg",
          "/usr/bin/ffmpeg",
          "/snap/bin/ffmpeg",
        ];

    for (const p of commonPaths) {
      if (p && fs.existsSync(p)) {
        const works = await testExecutable(p, ["-version"]);
        if (works) {
          _ffmpegPath = p;
          debugLog(`[platform] ffmpeg found at: ${p}`);
          return _ffmpegPath;
        }
      }
    }

    _ffmpegPath = null;
    return null;
  })().finally(() => {
    _ffmpegCheckPromise = null;
  });

  return _ffmpegCheckPromise;
}

/** Return true when an executable responds successfully to the given args. */
function testExecutable(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Reset ffmpeg detection state, mainly for tests. */
export function resetFfmpegCache(): void {
  _ffmpegPath = undefined;
  _ffmpegCheckPromise = null;
}

let _silkWasmAvailable: boolean | null = null;

/** Check whether silk-wasm can run in the current environment. */
export async function checkSilkWasmAvailable(): Promise<boolean> {
  if (_silkWasmAvailable !== null) {
    return _silkWasmAvailable;
  }

  try {
    const { isSilk } = await import("silk-wasm");
    // Use an empty buffer as a cheap smoke test for WASM loading.
    isSilk(new Uint8Array(0));
    _silkWasmAvailable = true;
    debugLog("[platform] silk-wasm: available");
  } catch (err) {
    _silkWasmAvailable = false;
    debugWarn(`[platform] silk-wasm: NOT available (${formatErrorMessage(err)})`);
  }
  return _silkWasmAvailable;
}

// Startup environment diagnostics.

export interface DiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  homeDir: string;
  tempDir: string;
  dataDir: string;
  ffmpeg: string | null;
  silkWasm: boolean;
  warnings: string[];
}

/**
 * Run startup diagnostics and return an environment report.
 * Called during gateway startup to log environment details and warnings.
 */
export async function runDiagnostics(): Promise<DiagnosticReport> {
  const warnings: string[] = [];

  const platform = `${process.platform} (${os.release()})`;
  const arch = process.arch;
  const nodeVersion = process.version;
  const homeDir = getHomeDir();
  const tempDir = getTempDir();
  const dataDir = getQQBotDataDir();

  // Check ffmpeg availability.
  const ffmpegPath = await detectFfmpeg();
  if (!ffmpegPath) {
    warnings.push(
      isWindows()
        ? "⚠️ ffmpeg is not installed. Audio/video conversion will be limited. Install it with choco install ffmpeg, scoop install ffmpeg, or from https://ffmpeg.org."
        : getPlatform() === "darwin"
          ? "⚠️ ffmpeg is not installed. Audio/video conversion will be limited. Install it with brew install ffmpeg."
          : "⚠️ ffmpeg is not installed. Audio/video conversion will be limited. Install it with sudo apt install ffmpeg or sudo yum install ffmpeg.",
    );
  }

  // Check silk-wasm availability.
  const silkWasm = await checkSilkWasmAvailable();
  if (!silkWasm) {
    warnings.push(
      "⚠️ silk-wasm is unavailable. QQ voice send/receive will not work. Ensure Node.js >= 16 and WASM support are available.",
    );
  }

  // Check whether the data directory is writable.
  try {
    const testFile = path.join(dataDir, ".write-test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch {
    warnings.push(`⚠️ Data directory is not writable: ${dataDir}. Check filesystem permissions.`);
  }

  // Windows-specific reminder.
  if (isWindows()) {
    // Chinese characters or spaces in the home path can break external tools.
    if (/[\u4e00-\u9fa5]/.test(homeDir) || homeDir.includes(" ")) {
      warnings.push(
        `⚠️ Home directory contains Chinese characters or spaces: ${homeDir}. Some tools may fail. Consider setting QQBOT_DATA_DIR to an ASCII-only path.`,
      );
    }
  }

  const report: DiagnosticReport = {
    platform,
    arch,
    nodeVersion,
    homeDir,
    tempDir,
    dataDir,
    ffmpeg: ffmpegPath,
    silkWasm,
    warnings,
  };

  // Print the report once for startup visibility.
  debugLog("=== QQBot Environment Diagnostics ===");
  debugLog(`  Platform: ${platform} (${arch})`);
  debugLog(`  Node: ${nodeVersion}`);
  debugLog(`  Home: ${homeDir}`);
  debugLog(`  Data dir: ${dataDir}`);
  debugLog(`  ffmpeg: ${ffmpegPath ?? "not installed"}`);
  debugLog(`  silk-wasm: ${silkWasm ? "available" : "unavailable"}`);
  if (warnings.length > 0) {
    debugLog("  --- Warnings ---");
    for (const w of warnings) {
      debugLog(`  ${w}`);
    }
  }
  debugLog("======================");

  return report;
}
