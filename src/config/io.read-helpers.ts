import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { loadDotEnv } from "../infra/dotenv.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { collectErrorGraphCandidates, extractErrorCode } from "../infra/errors.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isRecord } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  applyConfigEnvVars,
  createConfigRuntimeEnvBase,
  getPublishedConfigRuntimeEnvState,
} from "./config-env-vars.js";
import {
  type EnvSubstitutionWarning,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import {
  hashConfigIncludeRaw,
  INCLUDE_KEY,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludeWritePath,
  resolveConfigIncludes,
} from "./includes.js";
import type { ConfigIoDeps, NormalizedConfigIoDeps, ParseConfigJson5Result } from "./io.types.js";
import { resolveConfigPath, resolveIncludeRoots, resolveStateDir } from "./paths.js";
import { getRuntimeConfigSourceSnapshot } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

export function hashConfigRaw(raw: string | null): string {
  // Present-file hashes stay compatible with last-known-good recovery metadata.
  // Missing needs a distinct token so optimistic writes reject missing-to-empty races.
  if (raw === null) {
    return hashConfigIncludeRaw(null);
  }
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string") {
    const trimmed = snapshot.hash.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof snapshot.raw !== "string") {
    return null;
  }
  return hashConfigRaw(snapshot.raw);
}

export function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

export function hasConfigMeta(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return isRecord(value.meta);
}

export function resolveGatewayMode(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const gateway = value.gateway;
  if (!isRecord(gateway) || typeof gateway.mode !== "string") {
    return null;
  }
  const trimmed = gateway.mode.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function collectEnvRefPaths(
  value: unknown,
  pathLocal: string,
  output: Map<string, string>,
): void {
  if (typeof value === "string") {
    if (containsEnvVarReference(value)) {
      output.set(pathLocal, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectEnvRefPaths(item, `${pathLocal}[${index}]`, output);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectEnvRefPaths(child, pathLocal ? `${pathLocal}.${key}` : key, output);
    }
  }
}

export function containsConfigIncludeDirective(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsConfigIncludeDirective(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (INCLUDE_KEY in value) {
    return true;
  }
  return Object.values(value).some((item) => containsConfigIncludeDirective(item));
}

export function resolveConfigPathForDeps(deps: NormalizedConfigIoDeps): string {
  if (deps.configPath) {
    return deps.configPath;
  }
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}

export function normalizeConfigIoDeps(overrides: ConfigIoDeps = {}): NormalizedConfigIoDeps {
  const env = overrides.env ?? process.env;
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env,
    lowerPrecedenceEnv: overrides.lowerPrecedenceEnv ?? {},
    homedir: overrides.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)),
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
    measure: overrides.measure ?? (async (_name, run) => await run()),
    suppressFutureVersionWarning:
      overrides.suppressFutureVersionWarning ??
      (isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
        isTruthyEnvValue(env.OPENCLAW_UPDATE_POST_CORE)),
    observe: overrides.observe ?? true,
  };
}

export function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  // Injected env objects are test/diagnostic sandboxes and must stay isolated.
  if (env === process.env) {
    loadDotEnv({ quiet: true });
  }
}

export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: parseJsonWithJson5Fallback(raw, json5) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const TILDE_PATH_VALUE_RE = /^~(?=$|[\\/])/;
const PATH_LIKE_CONFIG_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIKE_CONFIG_LIST_KEYS = new Set(["paths", "pathPrepend"]);

function isPathLikeConfigKey(key: string | undefined): boolean {
  return Boolean(key && (PATH_LIKE_CONFIG_KEY_RE.test(key) || PATH_LIKE_CONFIG_LIST_KEYS.has(key)));
}

function expandAuthoredTildePath(value: string, home: string): string {
  const suffix = value.slice(1);
  if (!suffix) {
    return home;
  }
  if (suffix.startsWith("/") || suffix.startsWith("\\")) {
    return path.join(home, suffix.slice(1));
  }
  return value;
}

export function restoreAuthoredTildePathsForWrite(
  next: unknown,
  authored: unknown,
  key: string | undefined,
  home: string,
): unknown {
  if (
    typeof next === "string" &&
    typeof authored === "string" &&
    isPathLikeConfigKey(key) &&
    TILDE_PATH_VALUE_RE.test(authored.trim()) &&
    path.normalize(next) === path.normalize(expandAuthoredTildePath(authored.trim(), home))
  ) {
    return authored;
  }
  if (Array.isArray(next) && Array.isArray(authored)) {
    const normalizeChildren = isPathLikeConfigKey(key);
    return next.map((entry, index) =>
      restoreAuthoredTildePathsForWrite(
        entry,
        authored[index],
        normalizeChildren ? key : undefined,
        home,
      ),
    );
  }
  if (!isRecord(next) || !isRecord(authored)) {
    return next;
  }
  const out: Record<string, unknown> = { ...next };
  for (const [childKey, childValue] of Object.entries(out)) {
    if (Object.hasOwn(authored, childKey)) {
      out[childKey] = restoreAuthoredTildePathsForWrite(
        childValue,
        authored[childKey],
        childKey,
        home,
      );
    }
  }
  return out;
}

export function resolveConfigIncludesForRead(
  parsed: unknown,
  configPath: string,
  deps: NormalizedConfigIoDeps,
  includeFileHashesForWrite?: Record<string, string>,
  includeFileTargetsForWrite?: Record<string, string>,
  includeFilePathsForWatch?: Set<string>,
): unknown {
  const allowedRoots = resolveIncludeRoots(deps.env, deps.homedir);
  const recordIncludeWatchPath = (resolvedPath: string) => {
    includeFilePathsForWatch?.add(path.normalize(resolvedPath));
  };
  const recordIncludeTarget = (resolvedPath: string, canonicalPath?: string) => {
    if (!includeFileTargetsForWrite) {
      return;
    }
    const normalizedPath = path.normalize(resolvedPath);
    try {
      includeFileTargetsForWrite[normalizedPath] = path.normalize(
        canonicalPath ??
          resolveConfigIncludeWritePath({ configPath, includePath: resolvedPath, allowedRoots }),
      );
    } catch {
      // Unsafe targets remain unavailable to direct include mutation.
    }
  };
  return resolveConfigIncludes(
    parsed,
    configPath,
    {
      readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
      onLexicalPath: recordIncludeWatchPath,
      readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => {
        try {
          const raw = readConfigIncludeFileWithGuards({
            includePath,
            resolvedPath,
            rootRealDir,
            ioFs: deps.fs,
            onResolvedPath: (canonicalPath) => {
              recordIncludeWatchPath(canonicalPath);
              recordIncludeTarget(resolvedPath, canonicalPath);
            },
          });
          if (includeFileHashesForWrite) {
            includeFileHashesForWrite[path.normalize(resolvedPath)] = hashConfigIncludeRaw(raw);
          }
          return raw;
        } catch (error) {
          const missing = collectErrorGraphCandidates(error, (current) => [current.cause]).some(
            (candidate) => extractErrorCode(candidate) === "ENOENT",
          );
          if (includeFileHashesForWrite && missing) {
            includeFileHashesForWrite[path.normalize(resolvedPath)] = hashConfigIncludeRaw(null);
          }
          if (missing) {
            recordIncludeTarget(resolvedPath);
          }
          throw error;
        }
      },
      parseJson: (raw) => deps.json5.parse(raw),
    },
    { allowedRoots },
  );
}

type ConfigReadResolution = {
  resolvedConfigRaw: unknown;
  envSnapshotForRestore: Record<string, string | undefined>;
  envWarnings: EnvSubstitutionWarning[];
};

export function resolveConfigForRead(
  resolvedIncludes: unknown,
  env: NodeJS.ProcessEnv,
  lowerPrecedenceEnv: Readonly<Record<string, string>> = {},
): ConfigReadResolution {
  if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
    applyConfigEnvVars(resolvedIncludes as OpenClawConfig, env, { lowerPrecedenceEnv });
  }
  const envWarnings: EnvSubstitutionWarning[] = [];
  return {
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env, {
      onMissing: (warning) => envWarnings.push(warning),
    }),
    envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
    envWarnings,
  };
}

export function snapshotEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return { ...env };
}

export function replaceEnvSnapshot(
  env: NodeJS.ProcessEnv,
  next: Record<string, string | undefined>,
): void {
  for (const key of Object.keys(env)) {
    delete env[key];
  }
  Object.assign(env, next);
}

export function resolveManagedRuntimeEnvBaseline(): {
  generation: number;
  sourceConfig: OpenClawConfig;
} {
  const published = getPublishedConfigRuntimeEnvState();
  return {
    generation: published.generation,
    sourceConfig: published.sourceConfig ?? getRuntimeConfigSourceSnapshot() ?? {},
  };
}

export function createManagedRuntimeEnvBase(): NodeJS.ProcessEnv {
  return createConfigRuntimeEnvBase(resolveManagedRuntimeEnvBaseline().sourceConfig, process.env, {
    preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
  });
}

export function restoreEnvChangesIfUnchanged(params: {
  env: NodeJS.ProcessEnv;
  before: Record<string, string | undefined>;
  after: Record<string, string | undefined>;
}): void {
  const keys = new Set([...Object.keys(params.before), ...Object.keys(params.after)]);
  for (const key of keys) {
    if (params.before[key] === params.after[key] || params.env[key] !== params.after[key]) {
      continue;
    }
    const previous = params.before[key];
    if (previous === undefined) {
      delete params.env[key];
    } else {
      params.env[key] = previous;
    }
  }
}
