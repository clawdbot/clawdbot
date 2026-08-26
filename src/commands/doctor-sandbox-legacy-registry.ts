/** Doctor-only inspection and migration for legacy sandbox registry files. */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
} from "../agents/sandbox/constants.js";
import {
  insertSandboxBrowserRegistryEntryIfMissing,
  insertSandboxRegistryEntryIfMissing,
} from "../agents/sandbox/registry.js";
import { withFileLock } from "../infra/file-lock.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";

const RegistryEntrySchema = z
  .object({
    containerName: z.string(),
  })
  .passthrough();

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

type RegistryEntryPayload = z.infer<typeof RegistryEntrySchema>;
type RegistryFile = z.infer<typeof RegistryFileSchema>;

type ShardedRegistryRead = {
  entries: RegistryEntryPayload[];
  invalidFiles: string[];
};

type LegacyRegistryKind = "containers" | "browsers";

type LegacyRegistryTarget = {
  kind: LegacyRegistryKind;
  registryPath: string;
  shardedDir: string;
};

export type LegacySandboxRegistryInspection = {
  kind: LegacyRegistryKind;
  path: string;
  exists: boolean;
  valid: boolean;
  entries: number;
  source: "monolithic" | "sharded";
};

export type LegacySandboxRegistryMigrationResult = { kind: LegacyRegistryKind } & (
  | { status: "missing" }
  | { status: "migrated"; entries: number }
  | { status: "removed-empty" }
  | {
      status: "quarantined-invalid";
      path: string;
      quarantinePath: string;
    }
);

async function readLegacyRegistryFile(registryPath: string): Promise<RegistryFile | null> {
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    return safeParseJsonWithSchema(RegistryFileSchema, raw);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [] };
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
  }
}

async function readShardedEntriesDetailed(dir: string): Promise<ShardedRegistryRead> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [], invalidFiles: [] };
    }
    throw error;
  }

  const invalidFiles: string[] = [];
  const entries = await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map(async (name) => {
        const filePath = path.join(dir, name);
        try {
          const raw = await fs.readFile(filePath, "utf-8");
          const entry = safeParseJsonWithSchema(RegistryEntrySchema, raw);
          if (!entry) {
            invalidFiles.push(filePath);
          }
          return entry;
        } catch {
          invalidFiles.push(filePath);
          return null;
        }
      }),
  );
  return {
    entries: entries
      .filter((entry) => entry !== null)
      .toSorted((left, right) => left.containerName.localeCompare(right.containerName)),
    invalidFiles: invalidFiles.toSorted(),
  };
}

async function quarantineLegacyRegistry(registryPath: string): Promise<string> {
  const quarantinePath = `${registryPath}.invalid-${Date.now()}`;
  await fs.rename(registryPath, quarantinePath).catch(async (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      await fs.rm(registryPath, { force: true });
    }
  });
  return quarantinePath;
}

async function quarantineInvalidShards(
  dir: string,
  invalidFiles: readonly string[],
): Promise<string> {
  const quarantineDir = `${dir}.invalid-${Date.now()}`;
  await fs.mkdir(quarantineDir, { recursive: true });
  for (const invalidFile of invalidFiles) {
    await fs
      .rename(invalidFile, path.join(quarantineDir, path.basename(invalidFile)))
      .catch(async (error: unknown) => {
        const code = (error as { code?: string } | null)?.code;
        if (code !== "ENOENT") {
          throw error;
        }
      });
  }
  return quarantineDir;
}

function writeLegacyEntryIfMissing(kind: LegacyRegistryKind, entry: RegistryEntryPayload): void {
  if (kind === "containers") {
    insertSandboxRegistryEntryIfMissing({
      ...entry,
      containerName: entry.containerName,
      sessionKey: typeof entry.sessionKey === "string" ? entry.sessionKey : "",
      createdAtMs: typeof entry.createdAtMs === "number" ? entry.createdAtMs : 0,
      lastUsedAtMs: typeof entry.lastUsedAtMs === "number" ? entry.lastUsedAtMs : 0,
      image: typeof entry.image === "string" ? entry.image : "",
    });
    return;
  }
  insertSandboxBrowserRegistryEntryIfMissing({
    ...entry,
    containerName: entry.containerName,
    sessionKey: typeof entry.sessionKey === "string" ? entry.sessionKey : "",
    createdAtMs: typeof entry.createdAtMs === "number" ? entry.createdAtMs : 0,
    lastUsedAtMs: typeof entry.lastUsedAtMs === "number" ? entry.lastUsedAtMs : 0,
    image: typeof entry.image === "string" ? entry.image : "",
    cdpPort: typeof entry.cdpPort === "number" ? entry.cdpPort : 0,
  });
}

async function migrateMonolithicIfNeeded(
  target: LegacyRegistryTarget,
): Promise<LegacySandboxRegistryMigrationResult> {
  const { registryPath } = target;
  try {
    await fs.access(registryPath);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { kind: target.kind, status: "missing" };
    }
    throw error;
  }

  return await withFileLock(
    registryPath,
    {
      stale: 30_000,
      retries: { retries: 59, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
    },
    async () => {
      const registry = await readLegacyRegistryFile(registryPath);
      if (!registry) {
        const quarantinePath = await quarantineLegacyRegistry(registryPath);
        return {
          kind: target.kind,
          status: "quarantined-invalid",
          path: registryPath,
          quarantinePath,
        };
      }
      if (registry.entries.length === 0) {
        await fs.rm(registryPath, { force: true });
        return { kind: target.kind, status: "removed-empty" };
      }
      for (const entry of registry.entries) {
        writeLegacyEntryIfMissing(target.kind, entry);
      }
      await fs.rm(registryPath, { force: true });
      return {
        kind: target.kind,
        status: "migrated",
        entries: registry.entries.length,
      };
    },
  );
}

async function migrateShardedIfNeeded(
  target: LegacyRegistryTarget,
): Promise<LegacySandboxRegistryMigrationResult> {
  let dirExists = false;
  try {
    const stat = await fs.stat(target.shardedDir);
    dirExists = stat.isDirectory();
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  if (!dirExists) {
    return { kind: target.kind, status: "missing" };
  }
  const { entries, invalidFiles } = await readShardedEntriesDetailed(target.shardedDir);
  if (invalidFiles.length > 0) {
    for (const entry of entries) {
      writeLegacyEntryIfMissing(target.kind, entry);
    }
    const quarantinePath = await quarantineInvalidShards(target.shardedDir, invalidFiles);
    await fs.rm(target.shardedDir, { recursive: true, force: true });
    return {
      kind: target.kind,
      status: "quarantined-invalid",
      path: target.shardedDir,
      quarantinePath,
    };
  }
  if (entries.length === 0) {
    await fs.rm(target.shardedDir, { recursive: true, force: true });
    return { kind: target.kind, status: "removed-empty" };
  }
  for (const entry of entries) {
    writeLegacyEntryIfMissing(target.kind, entry);
  }
  await fs.rm(target.shardedDir, { recursive: true, force: true });
  return { kind: target.kind, status: "migrated", entries: entries.length };
}

function combineMigrationResults(
  target: LegacyRegistryTarget,
  monolithic: LegacySandboxRegistryMigrationResult,
  sharded: LegacySandboxRegistryMigrationResult,
): LegacySandboxRegistryMigrationResult {
  if (monolithic.status === "quarantined-invalid") {
    return monolithic;
  }
  if (sharded.status === "quarantined-invalid") {
    return sharded;
  }
  const entries =
    (monolithic.status === "migrated" ? monolithic.entries : 0) +
    (sharded.status === "migrated" ? sharded.entries : 0);
  if (entries > 0) {
    return { kind: target.kind, status: "migrated", entries };
  }
  if (monolithic.status === "removed-empty" || sharded.status === "removed-empty") {
    return { kind: target.kind, status: "removed-empty" };
  }
  return { kind: target.kind, status: "missing" };
}

function legacyRegistryTargets(): LegacyRegistryTarget[] {
  return [
    {
      kind: "containers",
      registryPath: SANDBOX_REGISTRY_PATH,
      shardedDir: SANDBOX_CONTAINERS_DIR,
    },
    {
      kind: "browsers",
      registryPath: SANDBOX_BROWSER_REGISTRY_PATH,
      shardedDir: SANDBOX_BROWSERS_DIR,
    },
  ];
}

/** Inspects old registry files without mutating them. */
export async function inspectLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryInspection[]
> {
  const inspections: LegacySandboxRegistryInspection[] = [];
  for (const target of legacyRegistryTargets()) {
    try {
      await fs.access(target.registryPath);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENOENT") {
        inspections.push({
          kind: target.kind,
          path: target.registryPath,
          source: "monolithic",
          exists: false,
          valid: true,
          entries: 0,
        });
      } else {
        throw error;
      }
    }

    if (!inspections.some((entry) => entry.kind === target.kind && entry.source === "monolithic")) {
      const registry = await readLegacyRegistryFile(target.registryPath);
      inspections.push({
        kind: target.kind,
        path: target.registryPath,
        source: "monolithic",
        exists: true,
        valid: Boolean(registry),
        entries: registry?.entries.length ?? 0,
      });
    }

    const sharded = await readShardedEntriesDetailed(target.shardedDir);
    let shardedExists = false;
    try {
      shardedExists = (await fs.stat(target.shardedDir)).isDirectory();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    inspections.push({
      kind: target.kind,
      path: target.shardedDir,
      source: "sharded",
      exists: shardedExists,
      valid: sharded.invalidFiles.length === 0,
      entries: sharded.entries.length,
    });
  }
  return inspections;
}

/** Migrates old registry files into SQLite when present. */
export async function migrateLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryMigrationResult[]
> {
  const results: LegacySandboxRegistryMigrationResult[] = [];
  for (const target of legacyRegistryTargets()) {
    const sharded = await migrateShardedIfNeeded(target);
    const monolithic = await migrateMonolithicIfNeeded(target);
    results.push(combineMigrationResults(target, monolithic, sharded));
  }
  return results;
}
