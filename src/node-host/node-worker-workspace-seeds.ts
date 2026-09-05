import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "../gateway/worker-environments/workspace-inventory-limits.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import type { NodeWorkerWorkspaceSeedInput } from "../worker/node-workspace-protocol.js";
import {
  selectWorkspaceSeedsToPrune,
  WORKSPACE_SEED_RETENTION,
} from "../worker/workspace-seed-retention.js";

const seedQueue = new KeyedAsyncQueue();

export async function copyNodeWorkerProjectSeedObjects(params: {
  seedsRoot: string;
  gatewayNamespace: string;
  seedKey: string;
  workspaceDir: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const root = await fsp.realpath(params.seedsRoot).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (!root) {
    return false;
  }
  const namespaceDir = path.join(root, params.gatewayNamespace);
  const seedDir = path.join(namespaceDir, params.seedKey);
  return await seedQueue.enqueue(seedDir, async () => {
    if (
      !(await readSeedDirectory(root, namespaceDir)) ||
      !(await readSeedDirectory(namespaceDir, seedDir))
    ) {
      return false;
    }
    const gitDir = path.join(seedDir, ".git");
    const objectsDir = path.join(gitDir, "objects");
    if (
      !(await readSeedDirectory(seedDir, gitDir)) ||
      !(await readSeedDirectory(gitDir, objectsDir))
    ) {
      throw new Error("Prepared project seed has no Git objects");
    }
    let bytes = 0;
    let entries = 0;
    // Only objects cross this boundary. Recreate config/index/refs locally and
    // omit info (including alternates), which can reference another repository.
    await fsp.cp(objectsDir, path.join(params.workspaceDir, ".git", "objects"), {
      recursive: true,
      filter: async (source) => {
        params.signal?.throwIfAborted();
        if (path.relative(objectsDir, source).split(path.sep)[0] === "info") {
          return false;
        }
        const stat = await fsp.lstat(source);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          throw new Error("Prepared project seed contains an unsafe Git object");
        }
        bytes += stat.isFile() ? stat.size : 0;
        if (
          ++entries > MAX_WORKSPACE_GIT_CANDIDATES ||
          bytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES
        ) {
          throw new Error("Prepared project seed Git objects exceed the transfer limit");
        }
        return true;
      },
    });
    params.signal?.throwIfAborted();
    return true;
  });
}

async function readSeedDirectory(parent: string, target: string): Promise<fs.Stats | undefined> {
  let stats: fs.Stats;
  try {
    stats = await fsp.lstat(target);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    path.dirname(await fsp.realpath(target)) !== parent
  ) {
    throw new Error("INVALID_REQUEST: workspace seed path escaped its owner root");
  }
  return stats;
}

async function removeSeedDirectory(root: string, target: string): Promise<void> {
  const parent = path.dirname(target);
  await readSeedDirectory(root, parent);
  if (await readSeedDirectory(parent, target)) {
    await fsp.rm(target, { recursive: true, force: true });
  }
}

async function pruneWorkspaceSeeds(
  root: string,
  namespaceDir: string,
  preserveKey: string,
): Promise<void> {
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of await fsp.readdir(namespaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const target = path.join(namespaceDir, entry.name);
    const stats = await readSeedDirectory(namespaceDir, target);
    if (stats) {
      entries.push({ name: entry.name, mtimeMs: stats.mtimeMs });
    }
  }
  for (const entry of selectWorkspaceSeedsToPrune(
    entries,
    WORKSPACE_SEED_RETENTION,
    Date.now(),
    preserveKey,
  )) {
    const target = path.join(namespaceDir, entry.name);
    await seedQueue.enqueue(target, async () => {
      const current = await readSeedDirectory(namespaceDir, target);
      // Apply/store can refresh a seed after enumeration; eviction shares their lock.
      if (current?.mtimeMs === entry.mtimeMs) {
        await removeSeedDirectory(root, target);
      }
    });
  }
}

export async function runNodeWorkerWorkspaceSeed(params: {
  seedsRoot: string;
  gatewayNamespace: string;
  workspaceDir: string;
  seed: NodeWorkerWorkspaceSeedInput;
  signal?: AbortSignal;
}): Promise<"applied" | "absent" | "fresh" | "stored"> {
  const { workspaceDir, seed, signal } = params;
  await fsp.mkdir(params.seedsRoot, { recursive: true });
  const root = await fsp.realpath(params.seedsRoot);
  const namespaceDir = path.join(root, params.gatewayNamespace);
  await fsp.mkdir(namespaceDir, { recursive: true });
  await readSeedDirectory(root, namespaceDir);
  const seedDir = path.join(namespaceDir, seed.key);
  // Seed paths never travel in argv: this operation owns the machine-cache boundary.
  const result = await seedQueue.enqueue(seedDir, async () => {
    signal?.throwIfAborted();
    const existing = await readSeedDirectory(namespaceDir, seedDir);
    if (seed.action === "apply") {
      if (!existing) {
        return "absent" as const;
      }
      await fsp.cp(seedDir, workspaceDir, { recursive: true, verbatimSymlinks: true });
      // Apply must not bump the seed mtime: it is the store-freshness clock. Active
      // seeds refresh it through the periodic re-store; bumping on use would mark a
      // stale seed permanently "fresh" and its content would never be replaced.
      return "applied" as const;
    }
    if (!(await readSeedDirectory(path.dirname(workspaceDir), workspaceDir))) {
      throw new Error("workspace seed source directory is missing");
    }
    if (existing && existing.mtimeMs > Date.now() - seed.maxAgeMs) {
      return "fresh" as const;
    }
    const temporary = await fsp.mkdtemp(path.join(namespaceDir, `.tmp-${seed.key}-`));
    try {
      await fsp.cp(workspaceDir, temporary, { recursive: true, verbatimSymlinks: true });
      signal?.throwIfAborted();
      await readSeedDirectory(root, namespaceDir);
      await readSeedDirectory(namespaceDir, temporary);
      await removeSeedDirectory(root, seedDir);
      await fsp.rename(temporary, seedDir);
    } finally {
      await removeSeedDirectory(root, temporary);
    }
    return "stored" as const;
  });
  if (result === "stored") {
    await pruneWorkspaceSeeds(root, namespaceDir, seed.key);
  }
  return result;
}
