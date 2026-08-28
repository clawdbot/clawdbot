import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import type { NodeWorkerWorkspaceSeedInput } from "../worker/node-workspace-protocol.js";

const MAX_SEED_ENTRIES = 6;
const SEED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const SEED_TEMP_RETENTION_MS = 60 * 60 * 1_000;
const seedQueue = new KeyedAsyncQueue();

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

async function pruneWorkspaceSeeds(root: string, namespaceDir: string): Promise<void> {
  const entries: Array<{ target: string; mtimeMs: number; temporary: boolean }> = [];
  for (const entry of await fsp.readdir(namespaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:[a-f0-9]{64}|\.tmp-[a-f0-9]{64}-.+)$/u.test(entry.name)) {
      continue;
    }
    const target = path.join(namespaceDir, entry.name);
    const stats = await readSeedDirectory(namespaceDir, target);
    if (stats) {
      entries.push({ target, mtimeMs: stats.mtimeMs, temporary: entry.name.startsWith(".tmp-") });
    }
  }
  let retained = 0;
  const now = Date.now();
  const newest = entries.toSorted(
    (left, right) => right.mtimeMs - left.mtimeMs || left.target.localeCompare(right.target),
  );
  for (const entry of newest) {
    const expired =
      now - entry.mtimeMs > (entry.temporary ? SEED_TEMP_RETENTION_MS : SEED_RETENTION_MS);
    if (!expired && (entry.temporary || ++retained <= MAX_SEED_ENTRIES)) {
      continue;
    }
    await seedQueue.enqueue(entry.target, async () => {
      const current = await readSeedDirectory(namespaceDir, entry.target);
      // Apply/store can refresh a seed after enumeration; eviction shares their lock.
      if (current?.mtimeMs === entry.mtimeMs) {
        await removeSeedDirectory(root, entry.target);
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
      const now = new Date();
      await fsp.utimes(seedDir, now, now);
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
    await pruneWorkspaceSeeds(root, namespaceDir);
  }
  return result;
}
