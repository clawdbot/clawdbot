// Resolves config, state, cache, and runtime filesystem paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "../cli/profile-utils.js";
import { resolveGatewayNativeServiceIdentityConflict } from "../daemon/constants.js";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import { isFastTestRuntimeEnv } from "../infra/test-runtime-env.js";
import type { OpenClawConfig } from "./types.js";

/**
 * Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_NIX_MODE === "1";
}

export let isNixMode = resolveIsNixMode();

// Support the remaining legacy pre-rebrand state dir.
const LEGACY_STATE_DIRNAMES = [".clawdbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json"] as const;

/** True when the root CLI selected a non-default isolated profile. */
export function isNamedProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  const profile = env.OPENCLAW_PROFILE?.trim();
  return Boolean(profile && profile.toLowerCase() !== "default");
}

function resolveDefaultHomeDir(): string {
  return resolveRequiredHomeDir(process.env, os.homedir);
}

function resolveSystemAccountHomeDir(): string {
  return os.userInfo().homedir;
}

/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
function envHomedir(env: NodeJS.ProcessEnv): () => string {
  return () => resolveRequiredHomeDir(env, os.homedir);
}

function legacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}

function newStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return path.join(homedir(), NEW_STATE_DIRNAME);
}

export function resolveLegacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return legacyStateDirs(homedir);
}

export function resolveNewStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return newStateDir(homedir);
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via OPENCLAW_STATE_DIR.
 * Default: ~/.openclaw
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  const newDir = newStateDir(effectiveHomedir);
  if (isFastTestRuntimeEnv(env)) {
    return newDir;
  }
  const legacyDirs = legacyStateDirs(effectiveHomedir);
  const hasNew = fs.existsSync(newDir);
  if (hasNew) {
    return newDir;
  }
  const existingLegacy = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  if (existingLegacy) {
    return existingLegacy;
  }
  return newDir;
}

function normalizePathForComparison(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Missing paths have no filesystem identity yet; exact resolution is the safe fallback.
    return resolved;
  }
}

/** Whether the process uses the default home-scoped state directory. */
export function isDefaultStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): boolean {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (!override) {
    // Preserve the default install path, including automatic legacy-state discovery.
    return true;
  }
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  return (
    normalizePathForComparison(resolveStateDir(env, effectiveHomedir)) ===
    normalizePathForComparison(newStateDir(effectiveHomedir))
  );
}

/** Canonical state directory name for the selected profile, mirroring root `--profile`. */
function profileStateDirName(env: NodeJS.ProcessEnv): string | null {
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (!profile || profile.toLowerCase() === "default") {
    return NEW_STATE_DIRNAME;
  }
  if (!isValidProfileName(profile)) {
    return null;
  }
  return `${NEW_STATE_DIRNAME}-${profile}`;
}

export function resolveNativeServiceProfileConflict(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (!profile || profile.toLowerCase() === "default") {
    return null;
  }
  // Normal macOS and Windows filesystems fold case, so case-distinct profile
  // names can share state and native-service paths even though the CLI keeps
  // them distinct. Leave the runtime profile valid, but deny service mutation.
  if (profile !== profile.toLowerCase()) {
    return profile;
  }
  if (platform !== "darwin") {
    return null;
  }
  // These names map to the shipped default Gateway and node-host LaunchAgent
  // labels, so authorizing them would let one profile control another service.
  return profile === "gateway" || profile === "node" ? profile : null;
}

/** Whether host service management belongs to the active default install identity. */
export function isDefaultInstallIdentity(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = resolveSystemAccountHomeDir,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const accountHome = resolveRequiredHomeDir({}, homedir);
  // Profiles have distinct host-service names; relocated homes do not. Keep
  // OPENCLAW_HOME isolated so an alternate state tree cannot adopt that service.
  if (env.OPENCLAW_HOME?.trim()) {
    return false;
  }
  if (
    normalizePathForComparison(resolveRequiredHomeDir(env, homedir)) !==
    normalizePathForComparison(accountHome)
  ) {
    return false;
  }
  if (
    resolveNativeServiceProfileConflict(env, platform) ||
    resolveGatewayNativeServiceIdentityConflict(env, platform)
  ) {
    return false;
  }
  const stateDirName = profileStateDirName(env);
  // Environment profiles can bypass root CLI parsing. Reject them before path
  // construction so separators or dot segments cannot authorize a host service.
  if (!stateDirName) {
    return false;
  }
  const canonicalStateDir = path.join(accountHome, stateDirName);
  if (
    normalizePathForComparison(resolveStateDir(env, envHomedir(env))) !==
    normalizePathForComparison(canonicalStateDir)
  ) {
    return false;
  }
  // Default installs historically allow implicit legacy config discovery.
  // Named profiles must resolve their own config so they cannot inherit the default profile.
  if (stateDirName === NEW_STATE_DIRNAME && !env.OPENCLAW_CONFIG_PATH?.trim()) {
    return true;
  }
  return (
    normalizePathForComparison(resolveConfigPathCandidate(env, envHomedir(env))) ===
    normalizePathForComparison(path.join(canonicalStateDir, CONFIG_FILENAME))
  );
}

export function normalizeStateDirEnv(env: NodeJS.ProcessEnv = process.env): void {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, envHomedir(env));
  const openclawOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (openclawOverride) {
    env.OPENCLAW_STATE_DIR = resolveUserPath(openclawOverride, env, effectiveHomedir);
  }
}

function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  return resolveHomeRelativePath(input, { env, homedir });
}

/**
 * Optional allowlist of directories that `$include` directives may resolve
 * outside the config directory. Set via `OPENCLAW_INCLUDE_ROOTS` as a
 * platform-delimited path list (`:` on POSIX, `;` on Windows).
 *
 * Each entry is tilde-expanded and resolved to an absolute path. Entries that
 * cannot be resolved or that are not absolute after expansion are dropped.
 *
 * Returns an empty array when the var is unset or contains no usable entries,
 * preserving the historical behavior where `$include` is confined to the
 * directory containing `openclaw.json`.
 */
export function resolveIncludeRoots(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  const raw = env.OPENCLAW_INCLUDE_ROOTS?.trim();
  if (!raw) {
    return [];
  }
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of raw.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(
      resolveHomeRelativePath(trimmed, { env, homedir: effectiveHomedir }),
    );
    if (!path.isAbsolute(resolved) || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

export let STATE_DIR = resolveStateDir();

/**
 * Config file path (JSON or JSON5).
 * Can be overridden via OPENCLAW_CONFIG_PATH.
 * Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
 */
export function resolveCanonicalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, CONFIG_FILENAME);
}

/**
 * Resolve the active config path by preferring existing config candidates
 * before falling back to the canonical path.
 */
export function resolveConfigPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  if (isFastTestRuntimeEnv(env)) {
    return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
  }
  const candidates = resolveDefaultConfigCandidates(env, homedir);
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}

/**
 * Active config path (prefers existing config files).
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
  homedir: () => string = envHomedir(env),
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  if (isFastTestRuntimeEnv(env)) {
    return path.join(stateDir, CONFIG_FILENAME);
  }
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  const candidates = [
    path.join(stateDir, CONFIG_FILENAME),
    ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name)),
  ];
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  if (stateOverride) {
    return path.join(stateDir, CONFIG_FILENAME);
  }
  const defaultStateDir = resolveStateDir(env, homedir);
  if (path.resolve(stateDir) === path.resolve(defaultStateDir)) {
    return resolveConfigPathCandidate(env, homedir);
  }
  return path.join(stateDir, CONFIG_FILENAME);
}

export let CONFIG_PATH = resolveConfigPathCandidate();

/**
 * Re-pins process-stable runtime paths after an early startup selector changes the environment.
 *
 * Gateway startup must call this before importing runtime modules that derive their own constants
 * from these live bindings, otherwise one process can split reads and writes across two targets.
 */
export function pinRuntimePaths(env: NodeJS.ProcessEnv = process.env): {
  configPath: string;
  stateDir: string;
} {
  normalizeStateDirEnv(env);
  isNixMode = resolveIsNixMode(env);
  STATE_DIR = resolveStateDir(env);
  CONFIG_PATH = resolveConfigPathCandidate(env);
  return { configPath: CONFIG_PATH, stateDir: STATE_DIR };
}

/**
 * Resolve default config path candidates across default locations.
 * Order: explicit config path → state-dir-derived paths → new default.
 */
export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit, env, effectiveHomedir)];
  }

  const candidates: string[] = [];
  const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (openclawStateDir) {
    const resolved = resolveUserPath(openclawStateDir, env, effectiveHomedir);
    candidates.push(path.join(resolved, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
  }

  const defaultDirs = [newStateDir(effectiveHomedir), ...legacyStateDirs(effectiveHomedir)];
  for (const dir of defaultDirs) {
    candidates.push(path.join(dir, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
  }
  return candidates;
}

export const DEFAULT_GATEWAY_PORT = 18789;

/**
 * Gateway lock directory (ephemeral).
 * Default: os.tmpdir()/openclaw-<uid> (uid suffix when available).
 */
export function resolveGatewayLockDir(tmpdir: () => string = os.tmpdir): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(base, suffix);
}

/**
 * Queue-owned copies of outbound attachments that have not been delivered yet,
 * held outside the media store so its TTL sweep cannot reclaim an attachment a
 * durable row still has to send.
 */
export function resolveDeliveryQueueMediaDir(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(), "delivery-queue-media");
}

/** Resolves the legacy credentials directory retained for Doctor and backup ownership. */
export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, "credentials");
}

function parseGatewayPortEnvValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return parseTcpPort(trimmed);
  }

  // Docker Compose publish strings can leak into host CLI env loading via repo `.env`,
  // for example `127.0.0.1:18789` or `[::1]:18789`. Accept only explicit host:port forms.
  const bracketedIpv6Match = trimmed.match(/^\[[^\]]+\]:(\d+)$/);
  if (bracketedIpv6Match?.[1]) {
    return parseTcpPort(bracketedIpv6Match[1]);
  }

  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon <= 0 || firstColon !== lastColon) {
    return null;
  }
  const suffix = trimmed.slice(firstColon + 1);
  if (!/^\d+$/.test(suffix)) {
    return null;
  }
  return parseTcpPort(suffix);
}

export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim();
  const envPort = parseGatewayPortEnvValue(envRaw);
  if (envPort !== null) {
    return envPort;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) {
      return configPort;
    }
  }
  return DEFAULT_GATEWAY_PORT;
}
