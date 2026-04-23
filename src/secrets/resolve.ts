import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ExecSecretProviderConfig,
  FileSecretProviderConfig,
  SecretProviderConfig,
  SecretRef,
  SecretRefSource,
} from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { inspectPathPermissions, safeStat } from "../security/audit-fs.js";
import { isPathInside } from "../security/scan-paths.js";
import { resolveUserPath } from "../utils.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { readJsonPointer } from "./json-pointer.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  SINGLE_VALUE_FILE_REF_ID,
  resolveDefaultSecretProviderAlias,
  secretRefKey,
} from "./ref-contract.js";
import type { SecretRefResolveCache } from "./resolve-types.js";
import { isNonEmptyString, isRecord, normalizePositiveInt } from "./shared.js";

const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_MAX_REFS_PER_PROVIDER = 512;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

export type { SecretRefResolveCache } from "./resolve-types.js";

type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};

type ResolutionLimits = {
  maxProviderConcurrency: number;
  maxRefsPerProvider: number;
  maxBatchBytes: number;
};

type ProviderResolutionOutput = Map<string, unknown>;

export class SecretProviderResolutionError extends Error {
  readonly scope = "provider" as const;
  readonly source: SecretRefSource;
  readonly provider: string;

  constructor(params: {
    source: SecretRefSource;
    provider: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "SecretProviderResolutionError";
    this.source = params.source;
    this.provider = params.provider;
  }
}

export class SecretRefResolutionError extends Error {
  readonly scope = "ref" as const;
  readonly source: SecretRefSource;
  readonly provider: string;
  readonly refId: string;

  constructor(params: {
    source: SecretRefSource;
    provider: string;
    refId: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "SecretRefResolutionError";
    this.source = params.source;
    this.provider = params.provider;
    this.refId = params.refId;
  }
}

export function isProviderScopedSecretResolutionError(
  value: unknown,
): value is SecretProviderResolutionError {
  return value instanceof SecretProviderResolutionError;
}

function isSecretResolutionError(
  value: unknown,
): value is SecretProviderResolutionError | SecretRefResolutionError {
  return (
    value instanceof SecretProviderResolutionError || value instanceof SecretRefResolutionError
  );
}

function providerResolutionError(params: {
  source: SecretRefSource;
  provider: string;
  message: string;
  cause?: unknown;
}): SecretProviderResolutionError {
  return new SecretProviderResolutionError(params);
}

function refResolutionError(params: {
  source: SecretRefSource;
  provider: string;
  refId: string;
  message: string;
  cause?: unknown;
}): SecretRefResolutionError {
  return new SecretRefResolutionError(params);
}

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

function resolveConfiguredProvider(ref: SecretRef, config: OpenClawConfig): SecretProviderConfig {
  const providerConfig = config.secrets?.providers?.[ref.provider];
  if (!providerConfig) {
    if (ref.source === "env" && ref.provider === resolveDefaultSecretProviderAlias(config, "env")) {
      return { source: "env" };
    }
    throw providerResolutionError({
      source: ref.source,
      provider: ref.provider,
      message: `Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`,
    });
  }
  if (providerConfig.source !== ref.source) {
    throw providerResolutionError({
      source: ref.source,
      provider: ref.provider,
      message: `Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
    });
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
  const cachedFilePayload = cache?.filePayloadByProvider?.get(cacheKey);
  if (cachedFilePayload) {
    return await cachedFilePayload;
  }

  const filePath = resolveUserPath(params.providerConfig.path);
  const readPromise = (async () => {
    const secureFilePath = await assertSecurePath({
      targetPath: filePath,
      label: `secrets.providers.${params.providerName}.path`,
      allowInsecurePath: params.providerConfig.allowInsecurePath,
    });
    const timeoutMs = normalizePositiveInt(
      params.providerConfig.timeoutMs,
      DEFAULT_FILE_TIMEOUT_MS,
    );
    const maxBytes = normalizePositiveInt(params.providerConfig.maxBytes, DEFAULT_FILE_MAX_BYTES);
    const abortController = new AbortController();
    const timeoutErrorMessage = `File provider "${params.providerName}" timed out after ${timeoutMs}ms.`;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        reject(new Error(timeoutErrorMessage));
      }, timeoutMs);
    });
    try {
      const payload = await Promise.race([
        fs.readFile(secureFilePath, { signal: abortController.signal }),
        timeoutPromise,
      ]);
      if (payload.byteLength > maxBytes) {
        throw new Error(`File provider "${params.providerName}" exceeded maxBytes (${maxBytes}).`);
      }
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
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(timeoutErrorMessage, { cause: error });
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  })();

  if (cache) {
    cache.filePayloadByProvider ??= new Map();
    cache.filePayloadByProvider.set(cacheKey, readPromise);
  }
  return await readPromise;
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
        source: "env",
        provider: params.providerName,
        refId: ref.id,
        message: `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${params.providerName}.allowlist.`,
      });
    }
    const envValue = params.env[ref.id];
    if (!isNonEmptyString(envValue)) {
      throw refResolutionError({
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
      throw refResolutionError({
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

type ExecRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: "exit" | "timeout" | "no-output-timeout";
};

function isIgnorableStdinWriteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String(error.code);
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

async function runExecResolver(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  noOutputTimeoutMs: number;
  maxOutputBytes: number;
}): Promise<ExecRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let noOutputTimedOut = false;
    let outputBytes = 0;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, params.timeoutMs);

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
        noOutputTimer = null;
      }
    };

    const armNoOutputTimer = () => {
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        noOutputTimedOut = true;
        child.kill("SIGKILL");
      }, params.noOutputTimeoutMs);
    };

    const append = (chunk: Buffer | string, target: "stdout" | "stderr") => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > params.maxOutputBytes) {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimers();
          reject(
            new Error(`Exec provider output exceeded maxOutputBytes (${params.maxOutputBytes}).`),
          );
        }
        return;
      }
      if (target === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      armNoOutputTimer();
    };

    armNoOutputTimer();
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error);
    });
    child.stdout?.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve({
        stdout,
        stderr,
        code,
        signal,
        termination: noOutputTimedOut ? "no-output-timeout" : timedOut ? "timeout" : "exit",
      });
    });

    const handleStdinError = (error: unknown) => {
      if (isIgnorableStdinWriteError(error) || settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdin?.on("error", handleStdinError);
    try {
      child.stdin?.end(params.input);
    } catch (error) {
      handleStdinError(error);
    }
  });
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
      return { [params.ids[0]]: trimmed };
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
      return { [params.ids[0]]: parsed };
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
    if (responseErrors && id in responseErrors) {
      const entry = responseErrors[id];
      if (isRecord(entry) && typeof entry.message === "string" && entry.message.trim()) {
        throw refResolutionError({
          source: "exec",
          provider: params.providerName,
          refId: id,
          message: `Exec provider "${params.providerName}" failed for id "${id}" (${entry.message.trim()}).`,
        });
      }
      throw refResolutionError({
        source: "exec",
        provider: params.providerName,
        refId: id,
        message: `Exec provider "${params.providerName}" failed for id "${id}".`,
      });
    }
    if (!(id in responseValues)) {
      throw refResolutionError({
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
  providerConfig: ExecSecretProviderConfig;
  env: NodeJS.ProcessEnv;
  limits: ResolutionLimits;
}): Promise<ProviderResolutionOutput> {
  const ids = [...new Set(params.refs.map((ref) => ref.id))];
  if (ids.length > params.limits.maxRefsPerProvider) {
    throw providerResolutionError({
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

  const timeoutMs = normalizePositiveInt(params.providerConfig.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
  const noOutputTimeoutMs = normalizePositiveInt(
    params.providerConfig.noOutputTimeoutMs,
    timeoutMs,
  );
  const maxOutputBytes = normalizePositiveInt(
    params.providerConfig.maxOutputBytes,
    DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  );
  const jsonOnly = params.providerConfig.jsonOnly ?? true;

  let result: ExecRunResult;
  try {
    result = await runExecResolver({
      command: secureCommandPath,
      args: params.providerConfig.args ?? [],
      cwd: path.dirname(secureCommandPath),
      env: childEnv,
      input,
      timeoutMs,
      noOutputTimeoutMs,
      maxOutputBytes,
    });
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

export async function resolveSecretRefValues(
  refs: SecretRef[],
  options: ResolveSecretRefOptions,
): Promise<Map<string, unknown>> {
  if (refs.length === 0) {
    return new Map();
  }
  const limits = resolveResolutionLimits(options.config);
  const uniqueRefs = new Map<string, SecretRef>();
  for (const ref of refs) {
    const id = ref.id.trim();
    if (!id) {
      throw new Error("Secret reference id is empty.");
    }
    if (ref.source === "exec" && !isValidExecSecretRefId(id)) {
      throw new Error(
        `${formatExecSecretRefIdValidationMessage()} (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    uniqueRefs.set(secretRefKey(ref), { ...ref, id });
  }

  const grouped = new Map<
    string,
    { source: SecretRefSource; providerName: string; refs: SecretRef[] }
  >();
  for (const ref of uniqueRefs.values()) {
    const key = toProviderKey(ref.source, ref.provider);
    const existing = grouped.get(key);
    if (existing) {
      existing.refs.push(ref);
      continue;
    }
    grouped.set(key, { source: ref.source, providerName: ref.provider, refs: [ref] });
  }

  const tasks = [...grouped.values()].map(
    (group) => async (): Promise<{ group: typeof group; values: ProviderResolutionOutput }> => {
      if (group.refs.length > limits.maxRefsPerProvider) {
        throw providerResolutionError({
          source: group.source,
          provider: group.providerName,
          message: `Secret provider "${group.providerName}" exceeded maxRefsPerProvider (${limits.maxRefsPerProvider}).`,
        });
      }
      const providerConfig = resolveConfiguredProvider(group.refs[0], options.config);
      const values = await resolveProviderRefs({
        refs: group.refs,
        source: group.source,
        providerName: group.providerName,
        providerConfig,
        options,
        limits,
      });
      return { group, values };
    },
  );

  const taskResults = await runTasksWithConcurrency({
    tasks,
    limit: limits.maxProviderConcurrency,
    errorMode: "stop",
  });
  if (taskResults.hasError) {
    throw taskResults.firstError;
  }

  const resolved = new Map<string, unknown>();
  for (const result of taskResults.results) {
    for (const ref of result.group.refs) {
      if (!result.values.has(ref.id)) {
        throw refResolutionError({
          source: result.group.source,
          provider: result.group.providerName,
          refId: ref.id,
          message: `Secret provider "${result.group.providerName}" did not return id "${ref.id}".`,
        });
      }
      resolved.set(secretRefKey(ref), result.values.get(ref.id));
    }
  }
  return resolved;
}

export async function resolveSecretRefValue(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<unknown> {
  const cache = options.cache;
  const key = secretRefKey(ref);
  const cachedResolvedValue = cache?.resolvedByRefKey?.get(key);
  if (cachedResolvedValue) {
    return await cachedResolvedValue;
  }

  const promise = (async () => {
    const resolved = await resolveSecretRefValues([ref], options);
    if (!resolved.has(key)) {
      throw refResolutionError({
        source: ref.source,
        provider: ref.provider,
        refId: ref.id,
        message: `Secret reference "${key}" resolved to no value.`,
      });
    }
    return resolved.get(key);
  })();

  if (cache) {
    cache.resolvedByRefKey ??= new Map();
    cache.resolvedByRefKey.set(key, promise);
  }
  return await promise;
}

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
