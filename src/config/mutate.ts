import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../infra/errors.js";
import { withFileLock } from "../infra/file-lock.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { isPathInside } from "../security/scan-paths.js";
import { isRecord } from "../utils.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { INCLUDE_KEY } from "./includes.js";
import { createInvalidConfigError, formatInvalidConfigDetails } from "./io.invalid-config.js";
import {
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  writeConfigFile,
  type ConfigWriteOptions,
} from "./io.js";
import { applyUnsetPathsForWrite, resolveManagedUnsetPathsForWrite } from "./io.write-prepare.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import { resolveConfigPath } from "./paths.js";
import {
  createRuntimeConfigWriteNotification,
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotRefreshHandler,
  getRuntimeConfigSourceSnapshot,
  notifyRuntimeConfigWriteListeners,
  resolveConfigWriteAfterWrite,
  resolveConfigWriteFollowUp,
  type ConfigWriteAfterWrite,
  type ConfigWriteFollowUp,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export type ConfigMutationBase = "runtime" | "source";

const CONFIG_MUTATION_LOCK_OPTIONS = {
  retries: {
    retries: 80,
    factor: 1.2,
    minTimeout: 25,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 30_000,
} as const;

const DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS = 5;
const activeConfigMutationLocks = new AsyncLocalStorage<Set<string>>();
const configMutationQueueTails = new Map<string, Promise<void>>();

export class ConfigMutationConflictError extends Error {
  readonly currentHash: string | null;

  constructor(message: string, params: { currentHash: string | null }) {
    super(message);
    this.name = "ConfigMutationConflictError";
    this.currentHash = params.currentHash;
  }
}

export type ConfigReplaceResult = {
  path: string;
  previousHash: string | null;
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  afterWrite: ConfigWriteAfterWrite;
  followUp: ConfigWriteFollowUp;
};

export type ConfigMutationIO = {
  readConfigFileSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
  writeConfigFile: (cfg: OpenClawConfig, options?: ConfigWriteOptions) => Promise<unknown>;
};

export type ConfigMutationContext = {
  snapshot: ConfigFileSnapshot;
  previousHash: string | null;
  attempt: number;
};

export type ConfigTransformResult<T> = {
  nextConfig: OpenClawConfig;
  result?: T;
};

export type ConfigMutationCommitParams = {
  nextConfig: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
  afterWrite: ConfigWriteAfterWrite;
  io?: ConfigMutationIO;
};

export type ConfigMutationCommitResult = {
  config: OpenClawConfig;
  afterWrite?: ConfigWriteAfterWrite;
};

export type ConfigMutationCommit = (
  params: ConfigMutationCommitParams,
) => Promise<ConfigMutationCommitResult>;

export type TransformConfigFileParams<T> = {
  base?: ConfigMutationBase;
  baseHash?: string;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  commit?: ConfigMutationCommit;
  transform: (
    currentConfig: OpenClawConfig,
    context: ConfigMutationContext,
  ) => Promise<ConfigTransformResult<T>> | ConfigTransformResult<T>;
};

export type TransformConfigFileWithRetryParams<T> = TransformConfigFileParams<T> & {
  maxAttempts?: number;
};

export type ConfigMutationResult<T> = ConfigReplaceResult & {
  result: T | undefined;
  attempts: number;
};

function assertBaseHashMatches(snapshot: ConfigFileSnapshot, expectedHash?: string): string | null {
  const currentHash = resolveConfigSnapshotHash(snapshot) ?? null;
  if (expectedHash !== undefined && expectedHash !== currentHash) {
    throw new ConfigMutationConflictError("config changed since last load", {
      currentHash,
    });
  }
  return currentHash;
}

async function withConfigMutationLock<T>(
  params: { io?: ConfigMutationIO; lockPath?: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (params.io) {
    return await fn();
  }
  const configPath = path.resolve(params.lockPath ?? resolveConfigPath());
  const activeLocks = activeConfigMutationLocks.getStore();
  if (activeLocks?.has(configPath)) {
    return await fn();
  }
  assertConfigWriteAllowedInCurrentMode({ configPath });
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });

  const previousTail = configMutationQueueTails.get(configPath) ?? Promise.resolve();
  let releaseQueueSlot!: () => void;
  const currentRun = new Promise<void>((resolve) => {
    releaseQueueSlot = resolve;
  });
  const currentTail = previousTail.catch(() => undefined).then(() => currentRun);
  configMutationQueueTails.set(configPath, currentTail);

  await previousTail.catch(() => undefined);
  try {
    const nextActiveLocks = new Set(activeLocks ?? []);
    nextActiveLocks.add(configPath);
    return await activeConfigMutationLocks.run(
      nextActiveLocks,
      async () => await withFileLock(configPath, CONFIG_MUTATION_LOCK_OPTIONS, fn),
    );
  } finally {
    releaseQueueSlot();
    if (configMutationQueueTails.get(configPath) === currentTail) {
      configMutationQueueTails.delete(configPath);
    }
  }
}

function markActiveConfigMutationPath(configPath: string): void {
  activeConfigMutationLocks.getStore()?.add(path.resolve(configPath));
}

function getChangedTopLevelKeys(base: unknown, next: unknown): string[] {
  if (!isRecord(base) || !isRecord(next)) {
    return isDeepStrictEqual(base, next) ? [] : ["<root>"];
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  return [...keys].filter((key) => !isDeepStrictEqual(base[key], next[key]));
}

function getSingleTopLevelIncludeTarget(params: {
  snapshot: ConfigFileSnapshot;
  key: string;
}): string | null {
  if (!isRecord(params.snapshot.parsed)) {
    return null;
  }
  const authoredSection = params.snapshot.parsed[params.key];
  if (!isRecord(authoredSection)) {
    return null;
  }
  const keys = Object.keys(authoredSection);
  const includeValue = authoredSection[INCLUDE_KEY];
  if (keys.length !== 1 || typeof includeValue !== "string") {
    return null;
  }

  const rootDir = path.dirname(params.snapshot.path);
  const resolved = path.normalize(
    path.isAbsolute(includeValue) ? includeValue : path.resolve(rootDir, includeValue),
  );
  if (!isPathInside(rootDir, resolved)) {
    return null;
  }
  return resolved;
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await replaceFileAtomic({
    filePath,
    content: `${JSON.stringify(value, null, 2)}\n`,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(filePath),
    beforeRename: async () => {
      await fs.access(filePath).then(
        async () => await maintainConfigBackups(filePath, fs),
        () => undefined,
      );
    },
  });
}

async function tryWriteSingleTopLevelIncludeMutation(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<boolean> {
  const nextConfig = applyUnsetPathsForWrite(
    params.nextConfig,
    resolveManagedUnsetPathsForWrite(params.writeOptions?.unsetPaths),
  );
  const changedKeys = getChangedTopLevelKeys(params.snapshot.sourceConfig, nextConfig);
  if (changedKeys.length !== 1 || changedKeys[0] === "<root>") {
    return false;
  }

  const key = changedKeys[0];
  const includePath = getSingleTopLevelIncludeTarget({ snapshot: params.snapshot, key });
  if (!includePath || !isRecord(nextConfig) || !(key in nextConfig)) {
    return false;
  }
  const nextConfigRecord = nextConfig as Record<string, unknown>;

  if (params.writeOptions?.skipPluginValidation) {
    // Skip the include fast path so the root writer handles the write with
    // plugin validation disabled end-to-end (including the post-write readback).
    return false;
  }

  const validated = validateConfigObjectWithPlugins(nextConfig);
  if (!validated.ok) {
    throw createInvalidConfigError(
      params.snapshot.path,
      formatInvalidConfigDetails(validated.issues),
    );
  }

  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
  const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
  const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
  await writeJsonFileAtomic(includePath, nextConfigRecord[key]);
  if (
    params.writeOptions?.skipRuntimeSnapshotRefresh &&
    !hadRuntimeSnapshot &&
    !getRuntimeConfigSnapshotRefreshHandler()
  ) {
    return true;
  }

  const refreshed = await (
    params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite
  )();
  const refreshedSnapshot = refreshed.snapshot;
  const persistedHash = resolveConfigSnapshotHash(refreshedSnapshot);
  if (!refreshedSnapshot.valid) {
    throw createInvalidConfigError(
      params.snapshot.path,
      formatInvalidConfigDetails(refreshedSnapshot.issues),
    );
  }
  if (!persistedHash) {
    throw new Error(
      `Config was written to ${params.snapshot.path}, but no persisted hash was available.`,
    );
  }

  const notifyCommittedWrite = () => {
    const currentRuntimeConfig = getRuntimeConfigSnapshot();
    if (!currentRuntimeConfig) {
      return;
    }
    notifyRuntimeConfigWriteListeners(
      createRuntimeConfigWriteNotification({
        configPath: params.snapshot.path,
        sourceConfig: refreshedSnapshot.sourceConfig,
        runtimeConfig: currentRuntimeConfig,
        persistedHash,
        afterWrite: params.afterWrite ?? params.writeOptions?.afterWrite,
      }),
    );
  };
  await finalizeRuntimeSnapshotWrite({
    nextSourceConfig: refreshedSnapshot.sourceConfig,
    hadRuntimeSnapshot,
    hadBothSnapshots,
    loadFreshConfig: () => refreshedSnapshot.runtimeConfig,
    notifyCommittedWrite,
    formatRefreshError: (error) => formatErrorMessage(error),
    createRefreshError: (detail, cause) =>
      new Error(
        `Config was written to ${params.snapshot.path}, but runtime snapshot refresh failed: ${detail}`,
        { cause },
      ),
  });
  return true;
}

export async function replaceConfigFile(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  snapshot?: ConfigFileSnapshot;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<ConfigReplaceResult> {
  return await withConfigMutationLock(
    { io: params.io, lockPath: params.snapshot?.path },
    async () => await replaceConfigFileUnlocked(params),
  );
}

async function replaceConfigFileUnlocked(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  snapshot?: ConfigFileSnapshot;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<ConfigReplaceResult> {
  const prepared =
    params.snapshot && params.writeOptions
      ? { snapshot: params.snapshot, writeOptions: params.writeOptions }
      : await (params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite)();
  const { snapshot, writeOptions } = prepared;
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
  markActiveConfigMutationPath(snapshot.path);
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const afterWrite = resolveConfigWriteAfterWrite(
    params.afterWrite ?? params.writeOptions?.afterWrite,
  );
  const wroteInclude = await tryWriteSingleTopLevelIncludeMutation({
    snapshot,
    nextConfig: params.nextConfig,
    afterWrite,
    writeOptions: params.writeOptions ?? writeOptions,
    io: params.io,
  });
  if (!wroteInclude) {
    await (params.io?.writeConfigFile ?? writeConfigFile)(params.nextConfig, {
      baseSnapshot: snapshot,
      ...writeOptions,
      ...params.writeOptions,
      afterWrite,
    });
  }
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: params.nextConfig,
    afterWrite,
    followUp: resolveConfigWriteFollowUp(afterWrite),
  };
}

async function commitPreparedConfigMutation(
  params: ConfigMutationCommitParams,
): Promise<ConfigMutationCommitResult> {
  const result = await replaceConfigFileUnlocked({
    nextConfig: params.nextConfig,
    snapshot: params.snapshot,
    baseHash: params.baseHash,
    writeOptions: {
      ...params.writeOptions,
      afterWrite: params.afterWrite,
    },
    io: params.io,
  });
  return {
    config: result.nextConfig,
    afterWrite: result.afterWrite,
  };
}

async function transformConfigFileAttempt<T>(
  params: TransformConfigFileParams<T>,
  attempt: number,
): Promise<ConfigMutationResult<T>> {
  const { snapshot, writeOptions } = await (
    params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite
  )();
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
  markActiveConfigMutationPath(snapshot.path);
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
  const afterWrite = resolveConfigWriteAfterWrite(
    params.afterWrite ?? params.writeOptions?.afterWrite,
  );
  const mergedWriteOptions = {
    ...writeOptions,
    ...params.writeOptions,
  };
  const transformed = await params.transform(baseConfig, { snapshot, previousHash, attempt });
  const committed = await (params.commit ?? commitPreparedConfigMutation)({
    nextConfig: transformed.nextConfig,
    snapshot,
    ...(previousHash !== null ? { baseHash: previousHash } : {}),
    writeOptions: mergedWriteOptions,
    afterWrite,
    io: params.io,
  });
  const committedAfterWrite = committed.afterWrite ?? afterWrite;
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: committed.config,
    result: transformed.result,
    attempts: attempt + 1,
    afterWrite: committedAfterWrite,
    followUp: resolveConfigWriteFollowUp(committedAfterWrite),
  };
}

export async function transformConfigFile<T = void>(
  params: TransformConfigFileParams<T>,
): Promise<ConfigMutationResult<T>> {
  return await withConfigMutationLock(
    { io: params.io },
    async () => await transformConfigFileAttempt(params, 0),
  );
}

export async function transformConfigFileWithRetry<T = void>(
  params: TransformConfigFileWithRetryParams<T>,
): Promise<ConfigMutationResult<T>> {
  const maxAttempts = params.maxAttempts ?? DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Config mutation maxAttempts must be a positive integer.");
  }
  return await withConfigMutationLock({ io: params.io }, async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await transformConfigFileAttempt(params, attempt);
      } catch (err) {
        if (err instanceof ConfigMutationConflictError && attempt < maxAttempts - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Config mutation retry loop exhausted unexpectedly.");
  });
}

export async function mutateConfigFile<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  mutate: (draft: OpenClawConfig, context: ConfigMutationContext) => Promise<T | void> | T | void;
}): Promise<ConfigMutationResult<T>> {
  return await transformConfigFile<T>({
    base: params.base,
    baseHash: params.baseHash,
    afterWrite: params.afterWrite,
    writeOptions: params.writeOptions,
    io: params.io,
    transform: async (currentConfig, context) => {
      const draft = structuredClone(currentConfig);
      const result = (await params.mutate(draft, context)) as T | undefined;
      return { nextConfig: draft, result };
    },
  });
}

export async function mutateConfigFileWithRetry<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  maxAttempts?: number;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  mutate: (draft: OpenClawConfig, context: ConfigMutationContext) => Promise<T | void> | T | void;
}): Promise<ConfigMutationResult<T>> {
  return await transformConfigFileWithRetry<T>({
    base: params.base,
    baseHash: params.baseHash,
    maxAttempts: params.maxAttempts,
    afterWrite: params.afterWrite,
    writeOptions: params.writeOptions,
    io: params.io,
    transform: async (currentConfig, context) => {
      const draft = structuredClone(currentConfig);
      const result = (await params.mutate(draft, context)) as T | undefined;
      return { nextConfig: draft, result };
    },
  });
}
