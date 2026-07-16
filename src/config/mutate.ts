// Applies scoped config mutations while preserving IO and observer state.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { formatErrorMessage } from "../infra/errors.js";
import { withFileLock } from "../infra/file-lock.js";
import { root as createFsRoot, type Root as FsSafeRoot } from "../infra/fs-safe.js";
import { isPathInside } from "../security/scan-paths.js";
import { isRecord } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import {
  applyConfigEnvVars,
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnvBase,
  getPublishedConfigRuntimeEnvState,
} from "./config-env-vars.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import {
  ConfigIncludeError,
  hashConfigIncludeRaw,
  INCLUDE_KEY,
  resolveConfigIncludeWritePath,
} from "./includes.js";
import { createInvalidConfigError, formatInvalidConfigDetails } from "./io.invalid-config.js";
import {
  createConfigIO,
  readConfigFileSnapshotForWrite,
  restoreEnvChangesIfUnchanged,
  resolveConfigSnapshotHash,
  writeConfigFile,
  type ConfigWriteOptions,
  type ConfigWriteResult,
} from "./io.js";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
  resolveWriteEnvSnapshotForPath,
} from "./io.write-prepare.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { ConfigMutationBase } from "./mutation-types.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import { resolveConfigPath } from "./paths.js";
import {
  createRuntimeConfigWriteNotification,
  finalizeRuntimeSnapshotWrite,
  hasManagedRuntimeConfigWriteOwner,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotRefreshHandler,
  getRuntimeConfigSourceSnapshot,
  notifyRuntimeConfigWriteListeners,
  preflightManagedRuntimeConfigWrite,
  preflightRuntimeSnapshotWrite,
  resolveConfigWriteAfterWrite,
  resolveConfigWriteFollowUp,
  type ConfigWriteAfterWrite,
  type ConfigWriteFollowUp,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

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
const configMutationQueue = new KeyedAsyncQueue();

export { ConfigMutationConflictError } from "./mutation-conflict.js";

export type ConfigReplaceResult = {
  path: string;
  previousHash: string | null;
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  persistedHash: string | null;
  afterWrite: ConfigWriteAfterWrite;
  followUp: ConfigWriteFollowUp;
};

export type ConfigMutationIO = {
  env?: NodeJS.ProcessEnv;
  readConfigFileSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
  writeConfigFile: (
    cfg: OpenClawConfig,
    options?: ConfigWriteOptions,
  ) => Promise<ConfigWriteResult | void>;
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
  persistedHash: string | null;
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

type ConfigMutationOwnership = {
  initialized: boolean;
  expectedConfigPath: string;
  ownedConfigPathForWrite?: string;
  assertConfigPathForWrite?: () => void;
};

function resolveManagedRuntimeEnvBaseline(): {
  generation: number;
  sourceConfig: OpenClawConfig;
} {
  // Accepted restart candidates publish env before the runtime snapshot advances.
  // Managed writes must stay on that publication generation to avoid mixed env refs.
  const published = getPublishedConfigRuntimeEnvState();
  return {
    generation: published.generation,
    sourceConfig: published.sourceConfig ?? getRuntimeConfigSourceSnapshot() ?? {},
  };
}

function assertManagedRuntimeEnvGeneration(generation: number): void {
  if (getPublishedConfigRuntimeEnvState().generation !== generation) {
    throw new ConfigMutationConflictError(
      "active config environment changed while preparing write",
      { currentHash: null },
    );
  }
}

function assertBaseHashMatches(snapshot: ConfigFileSnapshot, expectedHash?: string): string | null {
  const currentHash = resolveConfigSnapshotHash(snapshot) ?? null;
  if (expectedHash !== undefined && expectedHash !== currentHash) {
    throw new ConfigMutationConflictError("config changed since last load", {
      currentHash,
    });
  }
  return currentHash;
}

function assertExpectedConfigPathMatches(
  snapshot: ConfigFileSnapshot,
  expectedConfigPath?: string,
): void {
  if (expectedConfigPath !== undefined && expectedConfigPath !== snapshot.path) {
    throw new ConfigMutationConflictError("config path changed since last load", {
      currentHash: resolveConfigSnapshotHash(snapshot) ?? null,
      retryable: false,
    });
  }
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

  const nextActiveLocks = new Set(activeLocks ?? []);
  nextActiveLocks.add(configPath);
  return await configMutationQueue.enqueue(configPath, () =>
    activeConfigMutationLocks.run(
      nextActiveLocks,
      async () => await withFileLock(configPath, CONFIG_MUTATION_LOCK_OPTIONS, fn),
    ),
  );
}

function markActiveConfigMutationPath(configPath: string): void {
  activeConfigMutationLocks.getStore()?.add(path.resolve(configPath));
}

async function readConfigSnapshotForMutation(params: {
  ownedConfigPathForWrite?: string;
  io?: ConfigMutationIO;
  writeOptions?: ConfigWriteOptions;
}): Promise<{
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
}> {
  const options = params.writeOptions?.skipPluginValidation ? { skipPluginValidation: true } : {};
  if (params.io) {
    return await params.io.readConfigFileSnapshotForWrite(options);
  }
  if (params.ownedConfigPathForWrite) {
    const ioOptions = {
      configPath: params.ownedConfigPathForWrite,
      ...(params.writeOptions?.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
    };
    const io = hasManagedRuntimeConfigWriteOwner(params.ownedConfigPathForWrite)
      ? createConfigIO({
          ...ioOptions,
          env: createConfigRuntimeEnvBase(
            resolveManagedRuntimeEnvBaseline().sourceConfig,
            process.env,
            {
              preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
            },
          ),
        })
      : createConfigIO(ioOptions);
    return await io.readConfigFileSnapshotForWrite();
  }
  return await readConfigFileSnapshotForWrite(options);
}

function createConfigMutationOwnership(
  prepared: Awaited<ReturnType<typeof readConfigSnapshotForMutation>>,
  writeOptions?: ConfigWriteOptions,
): ConfigMutationOwnership {
  const mergedWriteOptions = {
    ...prepared.writeOptions,
    ...writeOptions,
  };
  return {
    initialized: true,
    expectedConfigPath: mergedWriteOptions.expectedConfigPath ?? prepared.snapshot.path,
    ownedConfigPathForWrite: mergedWriteOptions.ownedConfigPathForWrite,
    assertConfigPathForWrite: mergedWriteOptions.assertConfigPathForWrite,
  };
}

async function withConfigMutationSnapshotLock<T>(
  params: { writeOptions?: ConfigWriteOptions },
  fn: (prepared: Awaited<ReturnType<typeof readConfigSnapshotForMutation>>) => Promise<T>,
): Promise<T> {
  let lockPath = path.resolve(params.writeOptions?.ownedConfigPathForWrite ?? resolveConfigPath());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await withConfigMutationLock({ lockPath }, async () => {
      const prepared = await readConfigSnapshotForMutation({
        ...(params.writeOptions?.ownedConfigPathForWrite
          ? { ownedConfigPathForWrite: params.writeOptions.ownedConfigPathForWrite }
          : {}),
        writeOptions: params.writeOptions,
      });
      const preparedPath = path.resolve(prepared.snapshot.path);
      if (preparedPath !== lockPath) {
        return { done: false as const, lockPath: preparedPath };
      }
      return { done: true as const, value: await fn(prepared) };
    });
    if (outcome.done) {
      return outcome.value;
    }
    lockPath = outcome.lockPath;
  }
  throw new ConfigMutationConflictError("config path changed repeatedly while acquiring lock", {
    currentHash: null,
    retryable: false,
  });
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
  return path.normalize(
    path.isAbsolute(includeValue) ? includeValue : path.resolve(rootDir, includeValue),
  );
}

function containsConfigIncludeDirective(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsConfigIncludeDirective(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    Object.hasOwn(value, INCLUDE_KEY) ||
    Object.values(value).some((item) => containsConfigIncludeDirective(item))
  );
}

function snapshotProvesBrokenInclude(snapshot: ConfigFileSnapshot, includePath: string): boolean {
  return (
    !snapshot.valid &&
    snapshot.issues.some(
      (issue) =>
        /Failed to (?:read|parse) include file:/.test(issue.message) &&
        issue.message.includes(includePath),
    )
  );
}

function formatJsonFileValue(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type RootBoundIncludeFile = {
  absolutePath: string;
  relativePath: string;
  root: FsSafeRoot;
};

function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "not-found";
}

function resolveRootBoundRelativePath(target: RootBoundIncludeFile, absolutePath: string): string {
  const relativePath = path.relative(target.root.rootReal, path.resolve(absolutePath));
  const firstSegment = relativePath.split(path.sep)[0];
  if (path.isAbsolute(relativePath) || firstSegment === "..") {
    throw new Error(`Config include backup path escaped its approved root: ${absolutePath}`);
  }
  return relativePath;
}

async function resolveRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
}): Promise<RootBoundIncludeFile> {
  const absolutePath = resolveConfigIncludeWritePath(params);
  const candidateRoots = [path.dirname(params.configPath), ...params.allowedRoots];
  for (const candidateRoot of candidateRoots) {
    const rootReal = await fs.realpath(candidateRoot).catch(() => null);
    if (!rootReal || !isPathInside(rootReal, absolutePath)) {
      continue;
    }
    const relativePath = path.relative(rootReal, absolutePath);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(path.sep)[0] === ".."
    ) {
      continue;
    }
    return {
      absolutePath,
      relativePath,
      root: await createFsRoot(rootReal, {
        hardlinks: "reject",
        mkdir: true,
        mode: 0o600,
        symlinks: "reject",
      }),
    };
  }
  throw new Error(`Config include write path has no approved existing root: ${absolutePath}`);
}

async function resolveExpectedRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
  expectedAbsolutePath: string;
}): Promise<RootBoundIncludeFile> {
  let target: RootBoundIncludeFile;
  try {
    target = await resolveRootBoundIncludeFile(params);
  } catch (error) {
    if (
      error instanceof ConfigIncludeError ||
      (error instanceof Error &&
        error.message.startsWith("Config include write path has no approved existing root:"))
    ) {
      throw new ConfigMutationConflictError("included config target changed since last load", {
        currentHash: null,
      });
    }
    throw error;
  }
  if (path.normalize(target.absolutePath) !== path.normalize(params.expectedAbsolutePath)) {
    throw new ConfigMutationConflictError("included config target changed since last load", {
      currentHash: null,
    });
  }
  return target;
}

async function readRootBoundFileRawIfExists(target: RootBoundIncludeFile): Promise<string | null> {
  try {
    return await target.root.readText(target.relativePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function assertRootConfigStillMatchesSnapshot(snapshot: ConfigFileSnapshot): Promise<void> {
  let currentRaw: string | null = null;
  try {
    currentRaw = await fs.readFile(snapshot.path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  const currentHash = hashConfigIncludeRaw(currentRaw);
  const expectedHash = hashConfigIncludeRaw(snapshot.exists ? (snapshot.raw ?? null) : null);
  if (currentHash !== expectedHash) {
    throw new ConfigMutationConflictError("config changed while preparing include write", {
      currentHash,
    });
  }
}

async function rollbackJsonFileWriteIfUnchanged(params: {
  target: RootBoundIncludeFile;
  previousRaw: string | null;
  committedHash: string;
}): Promise<boolean> {
  const currentRaw = await readRootBoundFileRawIfExists(params.target);
  if (hashConfigIncludeRaw(currentRaw) !== params.committedHash) {
    return false;
  }
  if (params.previousRaw !== null) {
    await params.target.root.write(params.target.relativePath, params.previousRaw, {
      mkdir: true,
      mode: 0o600,
      overwrite: true,
    });
    return true;
  }
  try {
    await params.target.root.remove(params.target.relativePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  return true;
}

function createRootBoundBackupFs(target: RootBoundIncludeFile) {
  return {
    chmod: async (filePath: string, mode: number) => {
      const opened = await target.root.open(resolveRootBoundRelativePath(target, filePath));
      try {
        await opened.handle.chmod(mode);
      } finally {
        await opened[Symbol.asyncDispose]();
      }
    },
    copyFile: async (from: string, to: string) => {
      const content = await target.root.readBytes(resolveRootBoundRelativePath(target, from));
      await target.root.write(resolveRootBoundRelativePath(target, to), content, {
        mkdir: true,
        mode: 0o600,
        overwrite: true,
      });
    },
    readdir: async (dir: string) =>
      await target.root.list(resolveRootBoundRelativePath(target, dir)),
    rename: async (from: string, to: string) => {
      await target.root.move(
        resolveRootBoundRelativePath(target, from),
        resolveRootBoundRelativePath(target, to),
        { overwrite: true },
      );
    },
    unlink: async (filePath: string) => {
      await target.root.remove(resolveRootBoundRelativePath(target, filePath));
    },
  };
}

async function writeRootBoundJsonFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
  expectedTargetPath: string;
  value: unknown;
  expectedRaw: string | null;
  rootSnapshot: ConfigFileSnapshot;
  assertConfigPathForWrite: () => void;
  preCommitRuntimePreflight?: () => Promise<unknown>;
  skipOutputLogs?: boolean;
}): Promise<void> {
  params.assertConfigPathForWrite();
  const targetBeforeBackup = await resolveExpectedRootBoundIncludeFile({
    configPath: params.configPath,
    includePath: params.includePath,
    allowedRoots: params.allowedRoots,
    expectedAbsolutePath: params.expectedTargetPath,
  });
  if (await targetBeforeBackup.root.exists(targetBeforeBackup.relativePath)) {
    await maintainConfigBackups(
      targetBeforeBackup.absolutePath,
      createRootBoundBackupFs(targetBeforeBackup),
    );
  }
  const targetAtCommit = await resolveExpectedRootBoundIncludeFile({
    configPath: params.configPath,
    includePath: params.includePath,
    allowedRoots: params.allowedRoots,
    expectedAbsolutePath: params.expectedTargetPath,
  });
  params.assertConfigPathForWrite();
  await assertRootConfigStillMatchesSnapshot(params.rootSnapshot);
  const currentRaw = await readRootBoundFileRawIfExists(targetAtCommit);
  const currentHash = hashConfigIncludeRaw(currentRaw);
  if (currentHash !== hashConfigIncludeRaw(params.expectedRaw)) {
    throw new ConfigMutationConflictError("included config changed while preparing write", {
      currentHash,
    });
  }
  const content = formatJsonFileValue(params.value);
  // The include fast path bypasses writeConfigFile(); keep its authority guard
  // and comment warning on the final conflict-checked target. No later await may
  // run before the write.
  await params.preCommitRuntimePreflight?.();
  params.assertConfigPathForWrite();
  warnIfJSON5CommentsWillBeStripped({
    raw: currentRaw,
    filePath: targetAtCommit.absolutePath,
    skipOutputLogs: params.skipOutputLogs,
  });
  await targetAtCommit.root.write(targetAtCommit.relativePath, content, {
    mkdir: true,
    mode: 0o600,
    overwrite: true,
  });
  try {
    params.assertConfigPathForWrite();
  } catch (error) {
    await rollbackJsonFileWriteIfUnchanged({
      target: targetAtCommit,
      previousRaw: currentRaw,
      committedHash: hashConfigIncludeRaw(content),
    });
    throw error;
  }
}

async function tryWriteSingleTopLevelIncludeMutation(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<{ persistedHash: string | null; persistedConfig: OpenClawConfig } | null> {
  const nextConfig = applyUnsetPathsForWrite(
    params.nextConfig,
    resolveManagedUnsetPathsForWrite(params.writeOptions?.unsetPaths),
  );
  const changedKeys = getChangedTopLevelKeys(params.snapshot.sourceConfig, nextConfig);
  if (changedKeys.length !== 1 || changedKeys[0] === "<root>") {
    return null;
  }

  const key = expectDefined(changedKeys[0], "changed keys entry at 0");
  const includePath = getSingleTopLevelIncludeTarget({ snapshot: params.snapshot, key });
  if (!includePath || !isRecord(nextConfig) || !(key in nextConfig)) {
    return null;
  }
  const nextConfigRecord = nextConfig as Record<string, unknown>;

  const writeEnv = params.io?.env ?? process.env;
  const allowedRoots: readonly string[] = [];
  const expectedIncludeTarget = params.writeOptions?.includeFileTargetsForWrite?.[includePath];
  if (!expectedIncludeTarget) {
    throw new ConfigMutationConflictError("included config target changed since last load", {
      currentHash: null,
    });
  }
  const assertConfigPathForWrite = params.writeOptions?.assertConfigPathForWrite;
  if (!assertConfigPathForWrite) {
    return null;
  }
  assertConfigPathForWrite();
  const configRoot = await fs.realpath(path.dirname(params.snapshot.path));
  if (!isPathInside(configRoot, expectedIncludeTarget)) {
    throw new Error(
      `Config mutation cannot update external $include target ${includePath}; edit the included file directly or move it under the config directory.`,
    );
  }
  const includeTarget = await resolveExpectedRootBoundIncludeFile({
    configPath: params.snapshot.path,
    includePath,
    allowedRoots,
    expectedAbsolutePath: expectedIncludeTarget,
  });
  const previousIncludeRaw = await readRootBoundFileRawIfExists(includeTarget);
  const previousIncludeHash = hashConfigIncludeRaw(previousIncludeRaw);
  const expectedIncludeHash = params.writeOptions?.includeFileHashesForWrite?.[includePath];
  if (expectedIncludeHash !== undefined && expectedIncludeHash !== previousIncludeHash) {
    throw new ConfigMutationConflictError("included config changed since last load", {
      currentHash: previousIncludeHash,
    });
  }
  const envForRestore =
    resolveWriteEnvSnapshotForPath({
      actualConfigPath: params.snapshot.path,
      expectedConfigPath: params.writeOptions?.expectedConfigPath,
      envSnapshotForRestore: params.writeOptions?.envSnapshotForRestore,
    }) ??
    params.io?.env ??
    process.env;
  const snapshotHasBrokenInclude = snapshotProvesBrokenInclude(params.snapshot, includePath);
  if (
    previousIncludeRaw === null &&
    (!snapshotHasBrokenInclude || expectedIncludeHash === undefined)
  ) {
    throw new ConfigMutationConflictError("included config changed since last load", {
      currentHash: previousIncludeHash,
    });
  }
  let includedValueToWrite = nextConfigRecord[key];
  if (previousIncludeRaw !== null) {
    let authoredIncludeValue: unknown;
    let parsedInclude = false;
    try {
      authoredIncludeValue = parseJsonWithJson5Fallback(previousIncludeRaw);
      parsedInclude = true;
    } catch {
      // A validated replacement is the repair path for a malformed include.
      if (!snapshotHasBrokenInclude || expectedIncludeHash === undefined) {
        throw new ConfigMutationConflictError("included config changed since last load", {
          currentHash: previousIncludeHash,
        });
      }
    }
    if (parsedInclude) {
      if (containsConfigIncludeDirective(authoredIncludeValue)) {
        return null;
      }
      const currentIncludedValue = resolveConfigEnvVars(authoredIncludeValue, envForRestore, {
        onMissing: () => {},
      });
      const snapshotIncludedValue = (params.snapshot.sourceConfig as Record<string, unknown>)[key];
      if (!isDeepStrictEqual(currentIncludedValue, snapshotIncludedValue)) {
        throw new ConfigMutationConflictError("included config changed since last load", {
          currentHash: previousIncludeHash,
        });
      }
      includedValueToWrite = restoreEnvVarRefs(
        includedValueToWrite,
        authoredIncludeValue,
        envForRestore,
      );
    }
  }
  const deferRuntimeActivation = hasManagedRuntimeConfigWriteOwner(params.snapshot.path);
  const runtimeEnvBaseline = deferRuntimeActivation
    ? resolveManagedRuntimeEnvBaseline()
    : undefined;
  const runtimeCandidateEnv = runtimeEnvBaseline
    ? createConfigRuntimeEnvBase(runtimeEnvBaseline.sourceConfig, process.env, {
        preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
      })
    : cloneEnvWithPlatformSemantics(writeEnv);
  const authoredRuntimeCandidate = restoreEnvVarRefs(
    nextConfig,
    params.snapshot.parsed,
    envForRestore,
  ) as OpenClawConfig;
  applyConfigEnvVars(authoredRuntimeCandidate, runtimeCandidateEnv);
  const runtimeConfigToWrite = resolveConfigEnvVars(
    {
      ...authoredRuntimeCandidate,
      [key]: includedValueToWrite,
    },
    runtimeCandidateEnv,
    { onMissing: () => {} },
  ) as OpenClawConfig;
  const validated = validateConfigObjectWithPlugins(
    runtimeConfigToWrite,
    params.writeOptions?.skipPluginValidation ? { pluginValidation: "skip" } : undefined,
  );
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
  let managedPreparedCandidates = new Map<symbol, RuntimeConfigWritePreparedCandidate>();
  let runtimePreflightResult: unknown;
  if (runtimeEnvBaseline) {
    managedPreparedCandidates = await preflightManagedRuntimeConfigWrite(
      params.snapshot.path,
      runtimeConfigToWrite,
      params.writeOptions?.runtimeRefresh,
    );
    assertManagedRuntimeEnvGeneration(runtimeEnvBaseline.generation);
  } else {
    runtimePreflightResult = await preflightRuntimeSnapshotWrite({
      nextSourceConfig: runtimeConfigToWrite,
      refreshOptions: params.writeOptions?.runtimeRefresh,
      formatRefreshError: (error) => formatErrorMessage(error),
      createRefreshError: (detail, cause) =>
        new Error(
          `Config write blocked before committing ${includePath}: active SecretRef resolution failed: ${detail}`,
          { cause },
        ),
    });
  }
  const committedIncludeRaw = formatJsonFileValue(includedValueToWrite);
  const committedIncludeHash = hashConfigIncludeRaw(committedIncludeRaw);
  const callerPreCommit = params.writeOptions?.preCommitRuntimePreflight;
  assertConfigPathForWrite();
  await assertRootConfigStillMatchesSnapshot(params.snapshot);
  const includeRawAtCommit = await readRootBoundFileRawIfExists(includeTarget);
  if (hashConfigIncludeRaw(includeRawAtCommit) !== hashConfigIncludeRaw(previousIncludeRaw)) {
    throw new ConfigMutationConflictError("included config changed while preparing write", {
      currentHash: hashConfigIncludeRaw(includeRawAtCommit),
    });
  }
  await writeRootBoundJsonFile({
    configPath: params.snapshot.path,
    includePath,
    allowedRoots,
    expectedTargetPath: expectedIncludeTarget,
    value: includedValueToWrite,
    expectedRaw: includeRawAtCommit,
    rootSnapshot: params.snapshot,
    assertConfigPathForWrite,
    skipOutputLogs: params.writeOptions?.skipOutputLogs,
    preCommitRuntimePreflight:
      runtimeEnvBaseline || callerPreCommit
        ? async () => {
            if (runtimeEnvBaseline) {
              assertManagedRuntimeEnvGeneration(runtimeEnvBaseline.generation);
            }
            await callerPreCommit?.(runtimeConfigToWrite);
          }
        : undefined,
  });
  const envBeforePostWriteRead = { ...writeEnv };
  let envAfterPostWriteRead = envBeforePostWriteRead;
  try {
    if (
      params.writeOptions?.skipRuntimeSnapshotRefresh &&
      !hadRuntimeSnapshot &&
      !getRuntimeConfigSnapshotRefreshHandler()
    ) {
      return { persistedHash: null, persistedConfig: runtimeConfigToWrite };
    }

    let refreshed: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>;
    try {
      refreshed = await readConfigSnapshotForMutation({
        ownedConfigPathForWrite: params.snapshot.path,
        io: params.io,
        writeOptions: params.writeOptions,
      });
    } finally {
      envAfterPostWriteRead = { ...writeEnv };
    }
    const refreshedSnapshot = refreshed.snapshot;
    assertConfigPathForWrite();
    assertExpectedConfigPathMatches(refreshedSnapshot, params.snapshot.path);
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
      const notificationRuntimeConfig = deferRuntimeActivation
        ? refreshedSnapshot.runtimeConfig
        : currentRuntimeConfig;
      if (!notificationRuntimeConfig) {
        return;
      }
      const notificationPreparedCandidates = new Map(
        [...managedPreparedCandidates].map(([ownerId, candidate]) => [
          ownerId,
          {
            ...candidate,
            runtimeConfig:
              candidate.reapplyRuntimeOverlays?.(refreshedSnapshot.runtimeConfig) ??
              candidate.runtimeConfig,
            compareConfig:
              candidate.reapplyCompareOverlays?.(refreshedSnapshot.sourceConfig) ??
              candidate.compareConfig,
          },
        ]),
      );
      notifyRuntimeConfigWriteListeners(
        createRuntimeConfigWriteNotification({
          configPath: params.snapshot.path,
          sourceConfig: refreshedSnapshot.sourceConfig,
          runtimeConfig: notificationRuntimeConfig,
          persistedHash,
          afterWrite: params.afterWrite ?? params.writeOptions?.afterWrite,
          runtimeRefresh: params.writeOptions?.runtimeRefresh,
          ...(notificationPreparedCandidates.size > 0
            ? { preparedCandidatesByOwner: notificationPreparedCandidates }
            : {}),
        }),
      );
    };
    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig: refreshedSnapshot.sourceConfig,
      refreshOptions: params.writeOptions?.runtimeRefresh,
      hadRuntimeSnapshot,
      hadBothSnapshots,
      loadFreshConfig: () => refreshedSnapshot.runtimeConfig,
      notifyCommittedWrite,
      preflightResult: runtimePreflightResult,
      deferRuntimeActivation,
      formatRefreshError: (error) => formatErrorMessage(error),
      createRefreshError: (detail, cause) =>
        new Error(
          `Config was written to ${params.snapshot.path}, but runtime snapshot refresh failed: ${detail}`,
          { cause },
        ),
    });
    return { persistedHash, persistedConfig: refreshedSnapshot.sourceConfig };
  } catch (error) {
    try {
      const rolledBack = await rollbackJsonFileWriteIfUnchanged({
        target: includeTarget,
        previousRaw: includeRawAtCommit,
        committedHash: committedIncludeHash,
      });
      if (rolledBack) {
        restoreEnvChangesIfUnchanged({
          env: writeEnv,
          before: envBeforePostWriteRead,
          after: envAfterPostWriteRead,
        });
      }
    } catch (rollbackError) {
      throw new Error(
        `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

function resolveConfigWriteResult(
  result: ConfigWriteResult | void,
  fallbackConfig: OpenClawConfig,
): { persistedHash: string | null; persistedConfig: OpenClawConfig } {
  if (result) {
    return {
      persistedHash: result.persistedHash,
      persistedConfig: result.persistedConfig,
    };
  }
  return { persistedHash: null, persistedConfig: fallbackConfig };
}

export async function replaceConfigFile(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  snapshot?: ConfigFileSnapshot;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<ConfigReplaceResult> {
  if (!params.snapshot && !params.io) {
    return await withConfigMutationSnapshotLock(
      { writeOptions: params.writeOptions },
      async (prepared) =>
        await replaceConfigFileUnlocked({
          ...params,
          snapshot: prepared.snapshot,
          writeOptions: {
            ...prepared.writeOptions,
            ...params.writeOptions,
          },
        }),
    );
  }
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
  const prepared = params.snapshot
    ? { snapshot: params.snapshot, writeOptions: params.writeOptions ?? {} }
    : await readConfigSnapshotForMutation({
        io: params.io,
        writeOptions: params.writeOptions,
      });
  const { snapshot, writeOptions } = prepared;
  const mergedWriteOptions = {
    ...writeOptions,
    ...params.writeOptions,
  };
  mergedWriteOptions.assertConfigPathForWrite?.();
  assertExpectedConfigPathMatches(snapshot, mergedWriteOptions.expectedConfigPath);
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
  markActiveConfigMutationPath(snapshot.path);
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const afterWrite = resolveConfigWriteAfterWrite(
    params.afterWrite ?? params.writeOptions?.afterWrite,
  );
  let writeResult = await tryWriteSingleTopLevelIncludeMutation({
    snapshot,
    nextConfig: params.nextConfig,
    afterWrite,
    writeOptions: mergedWriteOptions,
    io: params.io,
  });
  if (!writeResult) {
    const fallbackWriteOptions: ConfigWriteOptions = {
      baseSnapshot: snapshot,
      ...mergedWriteOptions,
      afterWrite,
    };
    const ioPreCommitRuntimePreflight = params.io
      ? fallbackWriteOptions.preCommitRuntimePreflight
      : undefined;
    if (params.io) {
      fallbackWriteOptions.preCommitRuntimePreflight = async (sourceConfig) => {
        await preflightRuntimeSnapshotWrite({
          nextSourceConfig: sourceConfig,
          refreshOptions: fallbackWriteOptions.runtimeRefresh,
          formatRefreshError: (error) => formatErrorMessage(error),
          createRefreshError: (detail, cause) =>
            new Error(
              `Config write blocked before committing ${snapshot.path}: active SecretRef resolution failed: ${detail}`,
              { cause },
            ),
        });
        await ioPreCommitRuntimePreflight?.(sourceConfig);
      };
    }
    writeResult = resolveConfigWriteResult(
      await (params.io?.writeConfigFile ?? writeConfigFile)(
        params.nextConfig,
        fallbackWriteOptions,
      ),
      params.nextConfig,
    );
  }
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: writeResult.persistedConfig,
    persistedHash: writeResult.persistedHash,
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
    persistedHash: result.persistedHash,
    afterWrite: result.afterWrite,
  };
}

async function transformConfigFileAttempt<T>(
  params: TransformConfigFileParams<T>,
  attempt: number,
  ownership?: ConfigMutationOwnership,
  prepared?: Awaited<ReturnType<typeof readConfigSnapshotForMutation>>,
): Promise<ConfigMutationResult<T>> {
  ownership?.assertConfigPathForWrite?.();
  const { snapshot, writeOptions } =
    prepared ??
    (await readConfigSnapshotForMutation({
      ...(ownership?.ownedConfigPathForWrite
        ? { ownedConfigPathForWrite: ownership.ownedConfigPathForWrite }
        : {}),
      io: params.io,
      writeOptions: params.writeOptions,
    }));
  let mergedWriteOptions: ConfigWriteOptions = {
    ...writeOptions,
    ...params.writeOptions,
  };
  if (ownership) {
    if (!ownership.initialized) {
      ownership.initialized = true;
      ownership.expectedConfigPath = mergedWriteOptions.expectedConfigPath ?? snapshot.path;
      ownership.ownedConfigPathForWrite = mergedWriteOptions.ownedConfigPathForWrite;
      ownership.assertConfigPathForWrite = mergedWriteOptions.assertConfigPathForWrite;
    }
    mergedWriteOptions = {
      ...mergedWriteOptions,
      expectedConfigPath: ownership.expectedConfigPath,
      ...(ownership.ownedConfigPathForWrite
        ? { ownedConfigPathForWrite: ownership.ownedConfigPathForWrite }
        : {}),
      ...(ownership.assertConfigPathForWrite
        ? { assertConfigPathForWrite: ownership.assertConfigPathForWrite }
        : {}),
    };
  }
  mergedWriteOptions.assertConfigPathForWrite?.();
  assertExpectedConfigPathMatches(snapshot, mergedWriteOptions.expectedConfigPath);
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
  markActiveConfigMutationPath(snapshot.path);
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
  const afterWrite = resolveConfigWriteAfterWrite(
    params.afterWrite ?? params.writeOptions?.afterWrite,
  );
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
    persistedHash: committed.persistedHash,
    result: transformed.result,
    attempts: attempt + 1,
    afterWrite: committedAfterWrite,
    followUp: resolveConfigWriteFollowUp(committedAfterWrite),
  };
}

export async function transformConfigFile<T = void>(
  params: TransformConfigFileParams<T>,
): Promise<ConfigMutationResult<T>> {
  if (!params.io) {
    return await withConfigMutationSnapshotLock(
      { writeOptions: params.writeOptions },
      async (prepared) =>
        await transformConfigFileAttempt(
          params,
          0,
          createConfigMutationOwnership(prepared, params.writeOptions),
          prepared,
        ),
    );
  }
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
  const runWithPrepared = async (
    prepared?: Awaited<ReturnType<typeof readConfigSnapshotForMutation>>,
  ) => {
    const ownership = prepared
      ? createConfigMutationOwnership(prepared, params.writeOptions)
      : {
          initialized: false,
          expectedConfigPath: "",
        };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await transformConfigFileAttempt(
          params,
          attempt,
          ownership,
          attempt === 0 ? prepared : undefined,
        );
      } catch (err) {
        if (
          err instanceof ConfigMutationConflictError &&
          err.retryable &&
          attempt < maxAttempts - 1
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Config mutation retry loop exhausted unexpectedly.");
  };
  if (!params.io) {
    return await withConfigMutationSnapshotLock(
      { writeOptions: params.writeOptions },
      runWithPrepared,
    );
  }
  return await withConfigMutationLock({ io: params.io }, async () => await runWithPrepared());
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
