import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../infra/errors.js";
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

type ConfigMutationIO = {
  readConfigFileSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
  writeConfigFile: (cfg: OpenClawConfig, options?: ConfigWriteOptions) => Promise<unknown>;
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
  const prepared =
    params.snapshot && params.writeOptions
      ? { snapshot: params.snapshot, writeOptions: params.writeOptions }
      : await (params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite)();
  const { snapshot, writeOptions } = prepared;
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
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

export async function mutateConfigFile<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  mutate: (
    draft: OpenClawConfig,
    context: { snapshot: ConfigFileSnapshot; previousHash: string | null },
  ) => Promise<T | void> | T | void;
}): Promise<ConfigReplaceResult & { result: T | undefined }> {
  const { snapshot, writeOptions } = await (
    params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite
  )();
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
  const draft = structuredClone(baseConfig) as OpenClawConfig;
  const result = (await params.mutate(draft, { snapshot, previousHash })) as T | undefined;
  const afterWrite = resolveConfigWriteAfterWrite(
    params.afterWrite ?? params.writeOptions?.afterWrite,
  );
  const wroteInclude = await tryWriteSingleTopLevelIncludeMutation({
    snapshot,
    nextConfig: draft,
    afterWrite,
    writeOptions: {
      ...writeOptions,
      ...params.writeOptions,
    },
    io: params.io,
  });
  if (!wroteInclude) {
    await (params.io?.writeConfigFile ?? writeConfigFile)(draft, {
      ...writeOptions,
      ...params.writeOptions,
      afterWrite,
    });
  }
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: draft,
    result,
    afterWrite,
    followUp: resolveConfigWriteFollowUp(afterWrite),
  };
}
