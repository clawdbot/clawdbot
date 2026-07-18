/** Resolves SecretRef values from env, file, and exec secret providers. */
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  FileSecretProviderConfig,
  ManualExecSecretProviderConfig,
  SecretProviderConfig,
  SecretRef,
  SecretRefSource,
} from "../config/types.secrets.js";
import { isValidEnvSecretRefId } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { FsSafeError, readSecureFile } from "../infra/fs-safe.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { inspectPathPermissions, safeStat } from "../security/audit-fs.js";
import { isPathInside } from "../security/scan-paths.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { resolveUserPath } from "../utils.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { readJsonPointer } from "./json-pointer.js";
import {
  isPluginIntegrationSecretProviderConfig,
  resolveSecretProviderIntegrationConfig,
} from "./provider-integrations.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  isValidSecretProviderAlias,
  SINGLE_VALUE_FILE_REF_ID,
  resolveDefaultSecretProviderAlias,
  secretRefKey,
} from "./ref-contract.js";
import {
  isMissingSecretRefResolutionError,
  isProviderScopedSecretResolutionError,
  isSecretResolutionError,
  providerResolutionError,
  refResolutionError,
} from "./resolve-errors.js";
import type { SecretRefResolveCache } from "./resolve-types.js";
import {
  isNonEmptyString,
  isRecord,
  normalizePositiveInt,
  normalizePositiveTimerMs,
} from "./shared.js";

const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_MAX_REFS_PER_PROVIDER = 512;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
// Exec diagnostics cross CLI, RPC, and log boundaries; surface only canonical safe codes.
const SAFE_EXEC_ERROR_CODES = new Set(["AMBIGUOUS_DUPLICATE_KEY", "NOT_FOUND"]);
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

export type { SecretRefResolveCache } from "./resolve-types.js";

type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
};

type ResolutionLimits = {
  maxProviderConcurrency: number;
  maxRefsPerProvider: number;
  maxBatchBytes: number;
};

type ProviderResolutionOutput = Map<string, unknown>;

type ProviderRefGroup = {
  source: SecretRefSource;
  providerName: string;
  refs: SecretRef[];
};

export { isMissingSecretRefResolutionError, isProviderScopedSecretResolutionError };

function throwUnknownProviderResolutionError(params: {
  source: SecretRefSource;
  provider: string;
  err: unknown;
}): never {
  if (isSecretResolutionError(params.err)) {
    throw params.err;
  }
  throw providerResolutionError({
    source: params.source,
    provider: params.provider,
    message: formatErrorMessage(params.err),
    cause: params.err,
  });
}

async function readFileStatOrThrow(pathname: string, label: string) {
  const stat = await safeStat(pathname);
  if (!stat.ok) {
    throw new Error(`${label} is not readable: ${pathname}`);
  }
  if (stat.isDir) {
    throw new Error(`${label} must be a file: ${pathname}`);
  }
  return stat;
}

function isAbsolutePathname(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

function resolveResolutionLimits(config: OpenClawConfig): ResolutionLimits {
  const resolution = config.secrets?.resolution;
  return {
    maxProviderConcurrency: normalizePositiveInt(
      resolution?.maxProviderConcurrency,
      DEFAULT_PROVIDER_CONCURRENCY,
    ),
    maxRefsPerProvider: normalizePositiveInt(
      resolution?.maxRefsPerProvider,
      DEFAULT_MAX_REFS_PER_PROVIDER,
    ),
    maxBatchBytes: normalizePositiveInt(resolution?.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES),
  };
}

function toProviderKey(source: SecretRefSource, provider: string): string {
  return `${source}:${provider}`;
}

function resolveConfiguredProvider(params: {
  ref: SecretRef;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): SecretProviderConfig {
  const { ref, config } = params;
  const providerConfig = config.secrets?.providers?.[ref.provider];
  if (!providerConfig) {
    if (ref.source === "env" && ref.provider === resolveDefaultSecretProviderAlias(config, "env")) {
      return { source: "env" };
    }
    throw providerResolutionError({
      code: "SECRET_PROVIDER_INVALID",
      source: ref.source,
      provider: ref.provider,
      message: `Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`,
    });
  }
  if (providerConfig.source !== ref.source) {
    throw providerResolutionError({
      code: "SECRET_PROVIDER_INVALID",
      source: ref.source,
      provider: ref.provider,
      message: `Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
    });
  }
  if (isPluginIntegrationSecretProviderConfig(providerConfig)) {
    const manifestRegistry =
      params.manifestRegistry ??
      getCurrentPluginMetadataSnapshot({
        config,
        env: params.env,
        allowWorkspaceScopedSnapshot: true,
      })?.manifestRegistry ??
      loadPluginManifestRegistry({
        config,
        env: params.env,
      });
    const resolved = resolveSecretProviderIntegrationConfig({
      manifestRegistry,
      providerAlias: ref.provider,
      providerConfig,
      config,
      env: params.env,
    });
    if (!resolved.ok) {
      throw providerResolutionError({
        source: ref.source,
        provider: ref.provider,
        message: `Secret provider "${ref.provider}" plugin integration is unavailable: ${resolved.reason}.`,
      });
    }
    return resolved.providerConfig;
  }
  return providerConfig;
}

async function assertSecurePath(params: {
  targetPath: string;
  label: string;
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowReadableByOthers?: boolean;
  allowSymlinkPath?: boolean;
}): Promise<string> {
  if (!isAbsolutePathname(params.targetPath)) {
    throw new Error(`${params.label} must be an absolute path.`);
  }

  let effectivePath = params.targetPath;
  let stat = await readFileStatOrThrow(effectivePath, params.label);
  if (stat.isSymlink) {
    if (!params.allowSymlinkPath) {
      throw new Error(`${params.label} must not be a symlink: ${effectivePath}`);
    }
    try {
      effectivePath = await fs.realpath(effectivePath);
    } catch {
      throw new Error(`${params.label} symlink target is not readable: ${params.targetPath}`);
    }
    if (!isAbsolutePathname(effectivePath)) {
      throw new Error(`${params.label} resolved symlink target must be an absolute path.`);
    }
    stat = await readFileStatOrThrow(effectivePath, params.label);
    if (stat.isSymlink) {
      throw new Error(`${params.label} symlink target must not be a symlink: ${effectivePath}`);
    }
  }

  if (params.trustedDirs && params.trustedDirs.length > 0) {
    const trusted = params.trustedDirs.map((entry) => resolveUserPath(entry));
    const inTrustedDir = trusted.some((dir) => isPathInside(dir, effectivePath));
    if (!inTrustedDir) {
      throw new Error(`${params.label} is outside trustedDirs: ${effectivePath}`);
    }
  }
  if (params.allowInsecurePath) {
    return effectivePath;
  }

  const perms = await inspectPathPermissions(effectivePath);
  if (!perms.ok) {
    throw new Error(`${params.label} permissions could not be verified: ${effectivePath}`);
  }
  const writableByOthers = perms.worldWritable || perms.groupWritable;
  const readableByOthers = perms.worldReadable || perms.groupReadable;
  if (writableByOthers || (!params.allowReadableByOthers && readableByOthers)) {
    throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
  }

  if (process.platform === "win32" && perms.source === "unknown") {
    throw new Error(
      `${params.label} ACL verification unavailable on Windows for ${effectivePath}. Set allowInsecurePath=true for this provider to bypass this check when the path is trusted.`,
    );
  }

  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new Error(
        `${params.label} must be owned by the current user (uid=${uid}): ${effectivePath}`,
      );
    }
  }
  return effectivePath;
}

async function readFileProviderPayload(params: {
  providerName: string;
  providerConfig: FileSecretProviderConfig;
  cache?: SecretRefResolveCache;
}): Promise<unknown> {
  const cacheKey = params.providerName;
  const cache = params.cache;
  const read = async () => {
    const filePath = resolveUserPath(params.providerConfig.path);
    const timeoutMs = normalizePositiveTimerMs(
      params.providerConfig.timeoutMs,
      DEFAULT_FILE_TIMEOUT_MS,
    );
    const maxBytes = normalizePositiveInt(params.providerConfig.maxBytes, DEFAULT_FILE_MAX_BYTES);
    try {
      const { buffer: payload } = await readSecureFile({
        filePath,
        label: `secrets.providers.${params.providerName}.path`,
        io: { maxBytes, timeoutMs },
        permissions: { allowInsecure: params.providerConfig.allowInsecurePath },
      });
      const text = payload.toString("utf8").replace(/^\uFEFF/, "");
      if (params.providerConfig.mode === "singleValue") {
        return text.replace(/\r?\n$/, "");
      }
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) {
        throw new Error(`File provider "${params.providerName}" payload is not a JSON object.`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "timeout") {
        throw new Error(`File provider "${params.providerName}" timed out after ${timeoutMs}ms.`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  if (!cache) {
    return await read();
  }
  // Cache the in-flight read, not just the fulfilled payload, so concurrent refs share one
  // permission-checked file read and observe the same provider error.
  cache.filePayloadByProvider ??= new Map();
  return await getOrCreatePromise(cache.filePayloadByProvider, cacheKey, read);
}

async function resolveEnvRefs(params: {
  refs: SecretRef[];
  providerName: string;
  providerConfig: Extract<SecretProviderConfig, { source: "env" }>;
  env: NodeJS.ProcessEnv;
}): Promise<ProviderResolutionOutput> {
  const resolved = new Map<string, unknown>();
  const allowlist = params.providerConfig.allowlist
    ? new Set(params.providerConfig.allowlist)
    : null;
  for (const ref of params.refs) {
    if (allowlist && !allowlist.has(ref.id)) {
      throw refResolutionError({
        code: "SECRET_REF_POLICY_DENIED",
        source: "env",
        provider: params.providerName,
        refId: ref.id,
        message: `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${params.providerName}.allowlist.`,
      });
    }
    const envValue = params.env[ref.id];
    if (!isNonEmptyString(envValue)) {
      throw refResolutionError({
        code: "SECRET_REF_NOT_FOUND",
        source: "env",
        provider: params.providerName,
        refId: ref.id,
        message: `Environment variable "${ref.id}" is missing or empty.`,
      });
    }
    resolved.set(ref.id, envValue);
  }
  return resolved;
}

async function resolveFileRefs(params: {
  refs: SecretRef[];
  providerName: string;
  providerConfig: FileSecretProviderConfig;
  cache?: SecretRefResolveCache;
}): Promise<ProviderResolutionOutput> {
  let payload: unknown;
  try {
    payload = await readFileProviderPayload({
      providerName: params.providerName,
      providerConfig: params.providerConfig,
      cache: params.cache,
    });
  } catch (err) {
    throwUnknownProviderResolutionError({
      source: "file",
      provider: params.providerName,
      err,
    });
  }
  const mode = params.providerConfig.mode ?? "json";
  const resolved = new Map<string, unknown>();
  if (mode === "singleValue") {
    for (const ref of params.refs) {
      if (ref.id !== SINGLE_VALUE_FILE_REF_ID) {
        throw refResolutionError({
          code: "SECRET_REF_INVALID",
          source: "file",
          provider: params.providerName,
          refId: ref.id,
          message: `singleValue file provider "${params.providerName}" expects ref id "${SINGLE_VALUE_FILE_REF_ID}".`,
        });
      }
      resolved.set(ref.id, payload);
    }
    return resolved;
  }
  for (const ref of params.refs) {
    try {
      resolved.set(ref.id, readJsonPointer(payload, ref.id, { onMissing: "throw" }));
    } catch (err) {
      // File ref ids are validated before provider dispatch, so pointer failures here mean the
      // requested value is absent rather than the SecretRef contract being malformed.
      throw refResolutionError({
        code: "SECRET_REF_NOT_FOUND",
        source: "file",
        provider: params.providerName,
        refId: ref.id,
        message: formatErrorMessage(err),
        cause: err,
      });
    }
  }
  return resolved;
}

function parseExecValues(params: {
  providerName: string;
  ids: string[];
  stdout: string;
  jsonOnly: boolean;
}): Record<string, unknown> {
  const trimmed = params.stdout.trim();
  if (!trimmed) {
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" returned empty stdout.`,
    });
  }

  let parsed: unknown;
  if (!params.jsonOnly && params.ids.length === 1) {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { [expectDefined(params.ids[0], "ids entry at 0")]: trimmed };
    }
  } else {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw providerResolutionError({
        source: "exec",
        provider: params.providerName,
        message: `Exec provider "${params.providerName}" returned invalid JSON.`,
      });
    }
  }

  if (!isRecord(parsed)) {
    if (!params.jsonOnly && params.ids.length === 1 && typeof parsed === "string") {
      return { [expectDefined(params.ids[0], "ids entry at 0")]: parsed };
    }
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" response must be an object.`,
    });
  }
  if (parsed.protocolVersion !== 1) {
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" protocolVersion must be 1.`,
    });
  }
  const responseValues = parsed.values;
  if (!isRecord(responseValues)) {
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" response missing "values".`,
    });
  }
  const responseErrors = isRecord(parsed.errors) ? parsed.errors : null;
  const out: Record<string, unknown> = {};
  for (const id of params.ids) {
    if (responseErrors && Object.hasOwn(responseErrors, id)) {
      const entry = responseErrors[id];
      const code = isRecord(entry) && typeof entry.code === "string" ? entry.code : null;
      const safeCode = code && SAFE_EXEC_ERROR_CODES.has(code) ? code : null;
      throw refResolutionError({
        code: safeCode === "NOT_FOUND" ? "SECRET_REF_NOT_FOUND" : "SECRET_REF_PROVIDER_ERROR",
        source: "exec",
        provider: params.providerName,
        refId: id,
        message: `Exec provider "${params.providerName}" failed for id "${id}"${safeCode ? ` (${safeCode})` : ""}.`,
      });
    }
    if (!Object.hasOwn(responseValues, id)) {
      throw refResolutionError({
        code: "SECRET_REF_NOT_FOUND",
        source: "exec",
        provider: params.providerName,
        refId: id,
        message: `Exec provider "${params.providerName}" response missing id "${id}".`,
      });
    }
    out[id] = responseValues[id];
  }
  return out;
}

async function resolveExecRefs(params: {
  refs: SecretRef[];
  providerName: string;
  providerConfig: ManualExecSecretProviderConfig;
  env: NodeJS.ProcessEnv;
  limits: ResolutionLimits;
}): Promise<ProviderResolutionOutput> {
  const ids = uniqueStrings(params.refs.map((ref) => ref.id));
  if (ids.length > params.limits.maxRefsPerProvider) {
    throw providerResolutionError({
      code: "SECRET_PROVIDER_INVALID",
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" exceeded maxRefsPerProvider (${params.limits.maxRefsPerProvider}).`,
    });
  }

  const commandPath = resolveUserPath(params.providerConfig.command);
  let secureCommandPath: string;
  try {
    secureCommandPath = await assertSecurePath({
      targetPath: commandPath,
      label: `secrets.providers.${params.providerName}.command`,
      trustedDirs: params.providerConfig.trustedDirs,
      allowInsecurePath: params.providerConfig.allowInsecurePath,
      allowReadableByOthers: true,
      allowSymlinkPath: params.providerConfig.allowSymlinkCommand,
    });
  } catch (err) {
    throwUnknownProviderResolutionError({
      source: "exec",
      provider: params.providerName,
      err,
    });
  }

  const requestPayload = {
    protocolVersion: 1,
    provider: params.providerName,
    ids,
  };
  const input = JSON.stringify(requestPayload);
  if (Buffer.byteLength(input, "utf8") > params.limits.maxBatchBytes) {
    throw providerResolutionError({
      code: "SECRET_PROVIDER_INVALID",
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" request exceeded maxBatchBytes (${params.limits.maxBatchBytes}).`,
    });
  }

  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of params.providerConfig.passEnv ?? []) {
    const value = params.env[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(params.providerConfig.env ?? {})) {
    childEnv[key] = value;
  }

  const timeoutMs = normalizePositiveTimerMs(
    params.providerConfig.timeoutMs,
    DEFAULT_EXEC_TIMEOUT_MS,
  );
  const noOutputTimeoutMs = normalizePositiveTimerMs(
    params.providerConfig.noOutputTimeoutMs,
    timeoutMs,
  );
  const maxOutputBytes = normalizePositiveInt(
    params.providerConfig.maxOutputBytes,
    DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  );
  const jsonOnly = params.providerConfig.jsonOnly ?? true;

  let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    result = await runCommandWithTimeout(
      [secureCommandPath, ...(params.providerConfig.args ?? [])],
      {
        baseEnv: {},
        cwd: path.dirname(secureCommandPath),
        env: childEnv,
        input,
        killProcessTree: true,
        maxCombinedOutputBytes: maxOutputBytes,
        maxOutputBytes,
        noOutputTimeoutMs,
        outputCapture: "head",
        terminateOnOutputLimit: true,
        timeoutMs,
      },
    );
  } catch (err) {
    throwUnknownProviderResolutionError({
      source: "exec",
      provider: params.providerName,
      err,
    });
  }
  if (result.termination === "timeout") {
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" timed out after ${timeoutMs}ms.`,
    });
  }
  if (result.termination === "no-output-timeout") {
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" produced no output for ${noOutputTimeoutMs}ms.`,
    });
  }
  if (result.outputLimitExceeded) {
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider output exceeded maxOutputBytes (${maxOutputBytes}).`,
    });
  }
  if (result.code !== 0) {
    throw providerResolutionError({
      source: "exec",
      provider: params.providerName,
      message: `Exec provider "${params.providerName}" exited with code ${String(result.code)}.`,
    });
  }

  let values: Record<string, unknown>;
  try {
    values = parseExecValues({
      providerName: params.providerName,
      ids,
      stdout: result.stdout,
      jsonOnly,
    });
  } catch (err) {
    throwUnknownProviderResolutionError({
      source: "exec",
      provider: params.providerName,
      err,
    });
  }
  const resolved = new Map<string, unknown>();
  for (const id of ids) {
    resolved.set(id, values[id]);
  }
  return resolved;
}

async function resolveProviderRefs(params: {
  refs: SecretRef[];
  source: SecretRefSource;
  providerName: string;
  providerConfig: SecretProviderConfig;
  options: ResolveSecretRefOptions;
  limits: ResolutionLimits;
}): Promise<ProviderResolutionOutput> {
  try {
    if (params.providerConfig.source === "env") {
      return await resolveEnvRefs({
        refs: params.refs,
        providerName: params.providerName,
        providerConfig: params.providerConfig,
        env: params.options.env ?? process.env,
      });
    }
    if (params.providerConfig.source === "file") {
      return await resolveFileRefs({
        refs: params.refs,
        providerName: params.providerName,
        providerConfig: params.providerConfig,
        cache: params.options.cache,
      });
    }
    if (params.providerConfig.source === "exec") {
      if (isPluginIntegrationSecretProviderConfig(params.providerConfig)) {
        throw providerResolutionError({
          source: params.source,
          provider: params.providerName,
          message: `Secret provider "${params.providerName}" plugin integration was not materialized before exec resolution.`,
        });
      }
      return await resolveExecRefs({
        refs: params.refs,
        providerName: params.providerName,
        providerConfig: params.providerConfig,
        env: params.options.env ?? process.env,
        limits: params.limits,
      });
    }
    throw providerResolutionError({
      source: params.source,
      provider: params.providerName,
      message: `Unsupported secret provider source "${String((params.providerConfig as { source?: unknown }).source)}".`,
    });
  } catch (err) {
    return throwUnknownProviderResolutionError({
      source: params.source,
      provider: params.providerName,
      err,
    });
  }
}

function normalizeAndGroupSecretRefs(refs: SecretRef[]): ProviderRefGroup[] {
  if (refs.length === 0) {
    return [];
  }
  const uniqueRefs = new Map<string, SecretRef>();
  for (const ref of refs) {
    const id = ref.id.trim();
    if (!id) {
      throw new Error("Secret reference id is empty.");
    }
    if (!isValidSecretProviderAlias(ref.provider)) {
      throw new Error(
        `Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    if (ref.source === "env" && !isValidEnvSecretRefId(id)) {
      throw new Error(
        `Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    if (ref.source === "file" && !isValidFileSecretRefId(id)) {
      throw new Error(
        `File secret reference id must be an absolute JSON pointer or "value" (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    if (ref.source === "exec" && !isValidExecSecretRefId(id)) {
      throw new Error(
        `${formatExecSecretRefIdValidationMessage()} (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    uniqueRefs.set(secretRefKey(ref), { ...ref, id });
  }

  const grouped = new Map<string, ProviderRefGroup>();
  for (const ref of uniqueRefs.values()) {
    // Provider calls are batched by source/provider so exec providers receive one request for
    // many ids and file providers parse once per payload.
    const key = toProviderKey(ref.source, ref.provider);
    const existing = grouped.get(key);
    if (existing) {
      existing.refs.push(ref);
      continue;
    }
    grouped.set(key, { source: ref.source, providerName: ref.provider, refs: [ref] });
  }
  return [...grouped.values()];
}

function createProviderResolutionTasks(params: {
  groups: ProviderRefGroup[];
  options: ResolveSecretRefOptions;
  limits: ResolutionLimits;
}) {
  return params.groups.map(
    (group) => async (): Promise<{ group: ProviderRefGroup; values: ProviderResolutionOutput }> => {
      if (group.refs.length > params.limits.maxRefsPerProvider) {
        throw providerResolutionError({
          code: "SECRET_PROVIDER_INVALID",
          source: group.source,
          provider: group.providerName,
          message: `Secret provider "${group.providerName}" exceeded maxRefsPerProvider (${params.limits.maxRefsPerProvider}).`,
        });
      }
      const providerConfig = resolveConfiguredProvider({
        ref: expectDefined(group.refs[0], "refs entry at 0"),
        config: params.options.config,
        env: params.options.env ?? process.env,
        manifestRegistry: params.options.manifestRegistry,
      });
      const values = await resolveProviderRefs({
        refs: group.refs,
        source: group.source,
        providerName: group.providerName,
        providerConfig,
        options: params.options,
        limits: params.limits,
      });
      for (const ref of group.refs) {
        if (!values.has(ref.id)) {
          throw refResolutionError({
            code: "SECRET_REF_PROVIDER_CONTRACT",
            source: group.source,
            provider: group.providerName,
            refId: ref.id,
            message: `Secret provider "${group.providerName}" did not return id "${ref.id}".`,
          });
        }
      }
      return { group, values };
    },
  );
}

async function resolveSecretRefProviderGroups(params: {
  refs: SecretRef[];
  options: ResolveSecretRefOptions;
  errorMode: "continue" | "stop";
}) {
  const groups = normalizeAndGroupSecretRefs(params.refs);
  const limits = resolveResolutionLimits(params.options.config);
  const errorsByIndex = new Map<number, unknown>();
  const taskResults = await runTasksWithConcurrency({
    tasks: createProviderResolutionTasks({ groups, options: params.options, limits }),
    limit: limits.maxProviderConcurrency,
    errorMode: params.errorMode,
    onTaskError: (error, index) => {
      errorsByIndex.set(index, error);
    },
  });

  const resolved = new Map<string, unknown>();
  for (const result of taskResults.results) {
    if (!result) {
      continue;
    }
    for (const ref of result.group.refs) {
      resolved.set(secretRefKey(ref), result.values.get(ref.id));
    }
  }
  const failures: Array<{ group: ProviderRefGroup; error: unknown }> = [];
  for (const [index, group] of groups.entries()) {
    if (errorsByIndex.has(index)) {
      failures.push({ group, error: errorsByIndex.get(index) });
    }
  }
  return {
    resolved,
    failures,
    hasError: taskResults.hasError,
    firstError: taskResults.firstError,
  };
}

/** Resolves a batch of SecretRefs, grouped by provider for bounded provider concurrency. */
export async function resolveSecretRefValues(
  refs: SecretRef[],
  options: ResolveSecretRefOptions,
): Promise<Map<string, unknown>> {
  const result = await resolveSecretRefProviderGroups({ refs, options, errorMode: "stop" });
  if (result.hasError) {
    throw result.firstError;
  }
  return result.resolved;
}

/** Internal owner-isolation resolver that preserves one provider call per batch. */
export async function resolveSecretRefValuesSettledByProvider(
  refs: SecretRef[],
  options: ResolveSecretRefOptions,
) {
  const result = await resolveSecretRefProviderGroups({ refs, options, errorMode: "continue" });
  return { resolved: result.resolved, failures: result.failures };
}

/** Resolves one SecretRef, using the optional shared runtime cache. */
/** Resolves one SecretRef to an unknown value using configured provider state. */
export async function resolveSecretRefValue(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<unknown> {
  const cache = options.cache;
  const key = secretRefKey(ref);
  const resolve = async () => {
    const resolved = await resolveSecretRefValues([ref], options);
    if (!resolved.has(key)) {
      throw refResolutionError({
        code: "SECRET_REF_PROVIDER_CONTRACT",
        source: ref.source,
        provider: ref.provider,
        refId: ref.id,
        message: `Secret reference "${key}" resolved to no value.`,
      });
    }
    return resolved.get(key);
  };

  if (!cache) {
    return await resolve();
  }
  // Store the in-flight promise so repeated callers do not race duplicate provider work.
  cache.resolvedByRefKey ??= new Map();
  return await getOrCreatePromise(cache.resolvedByRefKey, key, resolve);
}

/** Resolves one SecretRef and requires a non-empty string result. */
export async function resolveSecretRefString(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<string> {
  const resolved = await resolveSecretRefValue(ref, options);
  if (!isNonEmptyString(resolved)) {
    throw new Error(
      `Secret reference "${ref.source}:${ref.provider}:${ref.id}" resolved to a non-string or empty value.`,
    );
  }
  return resolved;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
