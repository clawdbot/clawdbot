import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.access(filePath).then(
      async () => await maintainConfigBackups(filePath, fs),
      () => undefined,
    );
    await fs.rename(tmp, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {
      // best-effort
    });
  } catch (err) {
    await fs.unlink(tmp).catch(() => {
      // best-effort
    });
    throw err;
  }
}

async function tryWriteSingleTopLevelIncludeMutation(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  writeOptions?: ConfigWriteOptions;
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

  const validated = validateConfigObjectWithPlugins(nextConfig);
  if (!validated.ok) {
    throw createInvalidConfigError(
      params.snapshot.path,
      formatInvalidConfigDetails(validated.issues),
    );
  }

  await writeJsonFileAtomic(includePath, nextConfigRecord[key]);
  return true;
}

export async function replaceConfigFile(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  snapshot?: ConfigFileSnapshot;
  writeOptions?: ConfigWriteOptions;
}): Promise<ConfigReplaceResult> {
  const prepared =
    params.snapshot && params.writeOptions
      ? { snapshot: params.snapshot, writeOptions: params.writeOptions }
      : await readConfigFileSnapshotForWrite();
  const { snapshot, writeOptions } = prepared;
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const wroteInclude = await tryWriteSingleTopLevelIncludeMutation({
    snapshot,
    nextConfig: params.nextConfig,
    writeOptions: params.writeOptions ?? writeOptions,
  });
  if (!wroteInclude) {
    await writeConfigFile(params.nextConfig, {
      baseSnapshot: snapshot,
      ...writeOptions,
      ...params.writeOptions,
    });
  }
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: params.nextConfig,
  };
}

export async function mutateConfigFile<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
  mutate: (
    draft: OpenClawConfig,
    context: { snapshot: ConfigFileSnapshot; previousHash: string | null },
  ) => Promise<T | void> | T | void;
}): Promise<ConfigReplaceResult & { result: T | undefined }> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
  const draft = structuredClone(baseConfig) as OpenClawConfig;
  const result = (await params.mutate(draft, { snapshot, previousHash })) as T | undefined;
  const wroteInclude = await tryWriteSingleTopLevelIncludeMutation({
    snapshot,
    nextConfig: draft,
    writeOptions: {
      ...writeOptions,
      ...params.writeOptions,
    },
  });
  if (!wroteInclude) {
    await writeConfigFile(draft, {
      ...writeOptions,
      ...params.writeOptions,
    });
  }
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: draft,
    result,
  };
}
