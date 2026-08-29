import fsConstants, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxFsBridge, SandboxFsDirectoryEntry } from "./fs-bridge.types.js";

export type { SandboxFsDirectoryEntry } from "./fs-bridge.types.js";

export const SANDBOX_FS_DIRECTORY_MAX_ENTRIES = 10_000;
export const SANDBOX_FS_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
const LOCAL_DIRECTORY_READ_BUFFER_ENTRIES = 32;

export type SandboxFsDiscoveryBridge = SandboxFsBridge & {
  listDirectory: NonNullable<SandboxFsBridge["listDirectory"]>;
};

/** Directory listing capability of a safe filesystem root, as used by local bridge backends. */
export type SandboxDirectoryListingSource = {
  entries(
    relativePath: string,
    options: { signal?: AbortSignal },
  ): AsyncIterable<{ name: string; isDirectory: boolean; isFile: boolean }>;
};

export type SandboxDirectoryRoot = {
  readonly rootReal: string;
  resolve(relativePath: string): Promise<string>;
};

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function supportsDescriptorAnchoredSandboxDirectoryListing(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux";
}

function resolvePinnedDirectoryPath(fd: number): string {
  if (process.platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  throw new Error("Descriptor-anchored local directory listing is unavailable on this platform.");
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Adapts an authority-checked local root to descriptor-anchored directory enumeration. */
export function createDescriptorAnchoredSandboxDirectoryListingSource(
  root: SandboxDirectoryRoot,
): SandboxDirectoryListingSource {
  return {
    async *entries(relativePath, options) {
      options.signal?.throwIfAborted();
      const directoryPath = await root.resolve(relativePath);
      options.signal?.throwIfAborted();
      if (!supportsDescriptorAnchoredSandboxDirectoryListing()) {
        throw new Error(
          "Descriptor-anchored local directory listing is unavailable on this platform.",
        );
      }
      const handle = await fs.open(
        directoryPath,
        fsConstants.constants.O_RDONLY |
          fsConstants.constants.O_DIRECTORY |
          fsConstants.constants.O_NOFOLLOW |
          fsConstants.constants.O_NONBLOCK,
      );
      try {
        const stats = await handle.stat();
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new Error(`Sandbox directory listing target is not a directory: ${relativePath}`);
        }
        const pinnedPath = resolvePinnedDirectoryPath(handle.fd);
        const pinnedStats = await fs.stat(pinnedPath);
        const pinnedRealPath = await fs.realpath(pinnedPath);
        if (
          !sameDirectoryIdentity(stats, pinnedStats) ||
          !isPathInside(root.rootReal, pinnedRealPath)
        ) {
          throw new Error(`Sandbox directory listing target escaped its root: ${relativePath}`);
        }
        const directory = await fs.opendir(pinnedPath, {
          bufferSize: LOCAL_DIRECTORY_READ_BUFFER_ENTRIES,
        });
        try {
          while (true) {
            options.signal?.throwIfAborted();
            const entry = await directory.read();
            options.signal?.throwIfAborted();
            if (!entry) {
              return;
            }
            yield {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
            };
          }
        } finally {
          await directory.close();
        }
      } finally {
        await handle.close();
      }
    },
  };
}

export function supportsSandboxFsDiscovery(
  bridge: SandboxFsBridge,
): bridge is SandboxFsDiscoveryBridge {
  return typeof bridge.listDirectory === "function";
}

function assertSandboxDirectoryEntryCountWithinBounds(count: number): void {
  if (count > SANDBOX_FS_DIRECTORY_MAX_ENTRIES) {
    throw new Error(
      `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_ENTRIES} entry limit.`,
    );
  }
}

type SandboxDirectoryEntryBudget = {
  names: Set<string>;
  serializedBytes: number;
};

function createSandboxDirectoryEntryBudget(): SandboxDirectoryEntryBudget {
  return { names: new Set(), serializedBytes: 2 };
}

function admitSandboxDirectoryEntry(
  budget: SandboxDirectoryEntryBudget,
  entry: SandboxFsDirectoryEntry | undefined,
  index: number,
): void {
  if (
    !entry ||
    typeof entry.name !== "string" ||
    !entry.name ||
    entry.name === "." ||
    entry.name === ".." ||
    entry.name.includes("/") ||
    entry.name.includes("\\") ||
    entry.name.includes("\0") ||
    budget.names.has(entry.name) ||
    (entry.type !== "file" && entry.type !== "directory" && entry.type !== "other")
  ) {
    throw new Error("Sandbox directory listing returned an invalid entry.");
  }
  budget.names.add(entry.name);
  budget.serializedBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + (index > 0 ? 1 : 0);
  if (budget.serializedBytes > SANDBOX_FS_DIRECTORY_MAX_BYTES) {
    throw new Error(
      `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_BYTES} byte limit.`,
    );
  }
}

export function assertSandboxDirectoryEntriesWithinBounds(
  entries: readonly SandboxFsDirectoryEntry[],
): void {
  assertSandboxDirectoryEntryCountWithinBounds(entries.length);
  const budget = createSandboxDirectoryEntryBudget();
  for (let index = 0; index < entries.length; index++) {
    admitSandboxDirectoryEntry(budget, entries[index], index);
  }
}

/**
 * Lists one directory through a safe filesystem root while enforcing discovery
 * bounds and cancellation while the producer is still enumerating entries.
 */
export async function listSandboxDirectoryWithinBounds(params: {
  source: SandboxDirectoryListingSource;
  relativePath: string;
  signal?: AbortSignal;
}): Promise<SandboxFsDirectoryEntry[]> {
  const { source, relativePath, signal } = params;
  signal?.throwIfAborted();
  const entries: SandboxFsDirectoryEntry[] = [];
  const budget = createSandboxDirectoryEntryBudget();
  for await (const raw of source.entries(relativePath, { signal })) {
    signal?.throwIfAborted();
    assertSandboxDirectoryEntryCountWithinBounds(entries.length + 1);
    const entry: SandboxFsDirectoryEntry = {
      name: raw.name,
      type: raw.isDirectory ? "directory" : raw.isFile ? "file" : "other",
    };
    admitSandboxDirectoryEntry(budget, entry, entries.length);
    entries.push(entry);
  }
  return entries.toSorted((left, right) => {
    if (left.name < right.name) {
      return -1;
    }
    if (left.name > right.name) {
      return 1;
    }
    return 0;
  });
}

export function parseSandboxDirectoryEntries(value: Buffer): SandboxFsDirectoryEntry[] {
  if (value.byteLength > SANDBOX_FS_DIRECTORY_MAX_BYTES) {
    throw new Error(
      `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_BYTES} byte limit.`,
    );
  }
  const parsed: unknown = JSON.parse(value.toString("utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Sandbox directory listing returned an invalid result.");
  }
  if (parsed.length > SANDBOX_FS_DIRECTORY_MAX_ENTRIES) {
    throw new Error(
      `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_ENTRIES} entry limit.`,
    );
  }
  const entries = parsed.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Sandbox directory listing returned an invalid entry.");
    }
    const name = Reflect.get(entry, "name");
    const type = Reflect.get(entry, "type");
    if (
      typeof name !== "string" ||
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      (type !== "file" && type !== "directory" && type !== "other")
    ) {
      throw new Error("Sandbox directory listing returned an invalid entry.");
    }
    return { name, type };
  });
  assertSandboxDirectoryEntriesWithinBounds(entries);
  return entries;
}
