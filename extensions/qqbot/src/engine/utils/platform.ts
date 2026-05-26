/**
 * Cross-platform path and detection helpers for core/ modules.
 *
 * Provides home/data/media directory helpers, platform detection,
 * silk-wasm availability checks — all without importing `openclaw/plugin-sdk`.
 * The temp-directory fallback is delegated to the PlatformAdapter.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPlatformAdapter } from "../adapter/index.js";
import { formatErrorMessage } from "./format.js";
import { debugLog, debugWarn } from "./log.js";

/**
 * Resolve the current user's OS home directory safely across platforms.
 *
 * Priority:
 * 1. `os.homedir()`
 * 2. `$HOME` or `%USERPROFILE%`
 * 3. PlatformAdapter.getTempDir() as a last resort
 *
 * This is the *operating-system* home and intentionally ignores
 * `OPENCLAW_HOME`. Persistent QQ Bot data (sessions, known users, refs) is
 * keyed on this value to keep upgrades from hiding existing state when an
 * operator later sets `OPENCLAW_HOME`.
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

/**
 * Resolve the effective OpenClaw home directory.
 *
 * Mirrors the contract from core (`src/infra/home-dir.ts::resolveEffectiveHomeDir`)
 * so QQ Bot media roots live under the same tree the rest of OpenClaw treats as
 * `~`. The extension cannot import the core helper directly (it is a separate
 * package with `openclaw` as a peer dependency), so this re-implements the
 * minimal contract:
 *
 * 1. `OPENCLAW_HOME` when set (with `~` / `~/...` expanded against the OS home).
 * 2. Otherwise fall back to {@link getHomeDir} so existing single-home
 *    deployments are unaffected.
 *
 * Empty / `"undefined"` / `"null"` strings are treated as unset to match how
 * core normalizes the variable.
 */
function resolveOpenClawHome(): string {
  const raw = process.env.OPENCLAW_HOME?.trim();
  if (!raw || raw === "undefined" || raw === "null") {
    return getHomeDir();
  }

  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    const osHome = getHomeDir();
    if (raw === "~") {
      return osHome;
    }
    return path.join(osHome, raw.slice(2));
  }

  return raw;
}

/**
 * Return a path under `~/.openclaw/qqbot` without creating it.
 *
 * Anchored on the OS home (not `OPENCLAW_HOME`) so persisted QQ Bot data
 * (sessions, known users, ref index, credential backups) does not silently
 * disappear when an operator adds `OPENCLAW_HOME` after the fact.
 */
export function getQQBotDataPath(...subPaths: string[]): string {
  return path.join(getHomeDir(), ".openclaw", "qqbot", ...subPaths);
}

/** Return a path under `~/.openclaw/qqbot`, creating it on demand. */
export function getQQBotDataDir(...subPaths: string[]): string {
  const dir = getQQBotDataPath(...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Return a path under `<openclaw-home>/.openclaw/media/qqbot` without creating it.
 *
 * Unlike `getQQBotDataPath`, this lives under OpenClaw's core media allowlist
 * so downloaded images and audio can be accessed by framework media tooling.
 * The base honors `OPENCLAW_HOME` (when set) so files written by agents into
 * the OpenClaw-managed media tree are reachable by this plugin even when
 * `HOME` and `OPENCLAW_HOME` differ (Docker, multi-user hosts). Fixes #83562.
 */
export function getQQBotMediaPath(...subPaths: string[]): string {
  return path.join(resolveOpenClawHome(), ".openclaw", "media", "qqbot", ...subPaths);
}

/** Return a path under `<openclaw-home>/.openclaw/media/qqbot`, creating it on demand. */
export function getQQBotMediaDir(...subPaths: string[]): string {
  const dir = getQQBotMediaPath(...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Return `<openclaw-home>/.openclaw/media`, OpenClaw's shared media root.
 *
 * This mirrors the directory that core's `buildMediaLocalRoots` exposes as an
 * allowlisted location (see `openclaw/src/media/local-roots.ts`). Using it as a
 * QQ Bot payload root lets the plugin trust framework-produced files that live
 * in sibling subdirectories such as `outbound/` (written by
 * `saveMediaBuffer(..., "outbound", ...)`) or `inbound/`, while still keeping
 * the check anchored to a single, well-known directory. Like
 * {@link getQQBotMediaPath}, the base honors `OPENCLAW_HOME`.
 */
function getOpenClawMediaDir(): string {
  return path.join(resolveOpenClawHome(), ".openclaw", "media");
}

// ---- Basic platform information ----

type PlatformType = "darwin" | "linux" | "win32" | "other";

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

// ---- silk-wasm detection ----

let silkWasmAvailable: boolean | null = null;

/** Check whether silk-wasm can run in the current environment. */
export async function checkSilkWasmAvailable(): Promise<boolean> {
  if (silkWasmAvailable !== null) {
    return silkWasmAvailable;
  }
  try {
    const { isSilk } = await import("silk-wasm");
    isSilk(new Uint8Array(0));
    silkWasmAvailable = true;
    debugLog("[platform] silk-wasm: available");
  } catch (err) {
    silkWasmAvailable = false;
    debugWarn(`[platform] silk-wasm: NOT available (${formatErrorMessage(err)})`);
  }
  return silkWasmAvailable;
}

// ---- Tilde expansion and path normalization ----

/** Expand `~` to the current user's home directory. */
function expandTilde(p: string): string {
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

  const osHomeDir = getHomeDir();
  const openclawHomeDir = resolveOpenClawHome();
  const mediaRoot = getQQBotMediaPath();
  const dataRoot = getQQBotDataPath();
  // When OPENCLAW_HOME differs from HOME we have to consider workspace roots
  // under both trees: agents may be configured with `~`-relative paths (HOME)
  // or with the OpenClaw-managed home tree. Deduplicate when they match.
  const workspaceRoots = Array.from(
    new Set([
      path.join(osHomeDir, ".openclaw", "workspace", "qqbot"),
      path.join(openclawHomeDir, ".openclaw", "workspace", "qqbot"),
    ]),
  );
  const candidateRoots = [
    ...workspaceRoots.map((from) => ({ from, to: mediaRoot })),
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
  const allowedRoots = [getOpenClawMediaDir(), getQQBotMediaPath()];

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
