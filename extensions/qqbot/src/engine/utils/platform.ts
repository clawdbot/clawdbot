/**
 * Cross-platform path and detection helpers for core/ modules.
 *
 * Provides home/data/media directory helpers, platform detection,
 * ffmpeg/silk-wasm availability checks — all without importing
 * `openclaw/plugin-sdk`. The temp-directory fallback is delegated
 * to the PlatformAdapter.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPlatformAdapter } from "../adapter/index.js";
import { formatErrorMessage } from "./format.js";
import { debugLog, debugWarn } from "./log.js";

/**
 * Resolve the current user's home directory safely across platforms.
 *
 * Priority:
 * 1. `os.homedir()`
 * 2. `$HOME` or `%USERPROFILE%`
 * 3. PlatformAdapter.getTempDir() as a last resort
 */
export function getHomeDir(): string {
  try {
    const home = os.homedir();
    if (home && fs.existsSync(home)) {
      return home;
    }
  } catch {
    /* fallback */
  }

  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome && fs.existsSync(envHome)) {
    return envHome;
  }

  return getPlatformAdapter().getTempDir();
}

/** Return a path under `~/.openclaw/qqbot`, creating it on demand. */
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

/**
 * Return `~/.openclaw/media`, OpenClaw's shared media root.
 *
 * This mirrors the directory that core's `buildMediaLocalRoots` exposes as an
 * allowlisted location (see `openclaw/src/media/local-roots.ts`). Using it as a
 * QQ Bot payload root lets the plugin trust framework-produced files that live
 * in sibling subdirectories such as `outbound/` (written by
 * `saveMediaBuffer(..., "outbound", ...)`) or `inbound/`, while still keeping
 * the check anchored to a single, well-known directory.
 */
export function getOpenClawMediaDir(): string {
  return path.join(getHomeDir(), ".openclaw", "media");
}

// ---- Basic platform information ----

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

/** Return the preferred temporary directory. */
export function getTempDir(): string {
  return getPlatformAdapter().getTempDir();
}

// ---- ffmpeg detection ----

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

// ---- silk-wasm detection ----

let _silkWasmAvailable: boolean | null = null;

/** Check whether silk-wasm can run in the current environment. */
export async function checkSilkWasmAvailable(): Promise<boolean> {
  if (_silkWasmAvailable !== null) {
    return _silkWasmAvailable;
  }
  try {
    const { isSilk } = await import("silk-wasm");
    isSilk(new Uint8Array(0));
    _silkWasmAvailable = true;
    debugLog("[platform] silk-wasm: available");
  } catch (err) {
    _silkWasmAvailable = false;
    debugWarn(`[platform] silk-wasm: NOT available (${formatErrorMessage(err)})`);
  }
  return _silkWasmAvailable;
}

// ---- Tilde expansion and path normalization ----

/** Expand `~` to the current user's home directory. */
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

/** Normalize a user-provided path by trimming, stripping `file://`, and expanding `~`. */
export function normalizePath(p: string): string {
  let result = p.trim();
  if (result.startsWith("file://")) {
    result = result.slice("file://".length);
    try {
      result = decodeURIComponent(result);
    } catch {
      // Keep the raw string if decoding fails.
    }
  }
  return expandTilde(result);
}

// ---- Local path detection ----

/** Return true when the string looks like a local filesystem path rather than a URL. */
export function isLocalPath(p: string): boolean {
  if (!p) {
    return false;
  }
  if (p.startsWith("file://")) {
    return true;
  }
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return true;
  }
  if (p.startsWith("/")) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    return true;
  }
  if (p.startsWith("\\\\")) {
    return true;
  }
  if (p.startsWith("./") || p.startsWith("../")) {
    return true;
  }
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

// ---- QQBot media path resolution ----

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Remap legacy or hallucinated QQ Bot local media paths to real files when possible. */
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
  // Trust both the QQ Bot-owned subdirectory and OpenClaw's shared `~/.openclaw/media`
  // root. Core helpers like `saveMediaBuffer(..., "outbound", ...)` place framework
  // attachments under sibling directories (e.g. `media/outbound/`) that are already
  // part of the core media allowlist; we mirror that so auto-routed sends work
  // without leaving the plugin's trust boundary.
  const allowedRoots = [getOpenClawMediaDir(), getQQBotMediaDir()];

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
