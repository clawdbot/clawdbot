// Contract tests for writeMemoryCoreWorkspaceEntries skip-unchanged behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runDreamingSweepPhases } from "./dreaming-phases.js";
import {
  configureMemoryCoreDreamingState,
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { resetMemoryCoreDreamingStateForTests } from "./test-helpers.js";

const MEMORY_CORE_PLUGIN_ID = "memory-core";
const tempDirs: string[] = [];

type WriteCounts = {
  register: number;
  delete: number;
};

let writeCounts: WriteCounts = { register: 0, delete: 0 };
const writeCountsByNamespace = new Map<string, WriteCounts>();

function resetWriteCounts(): void {
  writeCounts = { register: 0, delete: 0 };
  writeCountsByNamespace.clear();
}

function incrementNamespaceWriteCount(namespace: string, operation: keyof WriteCounts): void {
  const counts = writeCountsByNamespace.get(namespace) ?? { register: 0, delete: 0 };
  counts[operation] += 1;
  writeCountsByNamespace.set(namespace, counts);
}

function namespaceWriteCounts(namespace: string): WriteCounts {
  return writeCountsByNamespace.get(namespace) ?? { register: 0, delete: 0 };
}

function wrapStoreWithWriteCounts<T>(
  store: PluginStateKeyedStore<T>,
  namespace: string,
): PluginStateKeyedStore<T> {
  return {
    ...store,
    register: async (key, value, opts) => {
      writeCounts.register += 1;
      incrementNamespaceWriteCount(namespace, "register");
      await store.register(key, value, opts);
    },
    delete: async (key) => {
      writeCounts.delete += 1;
      incrementNamespaceWriteCount(namespace, "delete");
      return store.delete(key);
    },
  };
}

function configureCountedDreamingState(params?: {
  maxEntriesByNamespace?: Readonly<Record<string, number>>;
}): void {
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    wrapStoreWithWriteCounts(
      createPluginStateKeyedStoreForTests<T>(MEMORY_CORE_PLUGIN_ID, {
        ...options,
        // Capacity tests override maxEntries for a dedicated namespace so
        // eviction can be proven without writing the production 50_000-row
        // cap or reopening production namespaces with a conflicting limit.
        maxEntries: params?.maxEntriesByNamespace?.[options.namespace] ?? options.maxEntries,
        env: process.env,
      }),
      options.namespace,
    ),
  );
}

beforeAll(() => {
  configureCountedDreamingState();
});

afterAll(() => {
  resetMemoryCoreDreamingStateForTests();
});

afterEach(async () => {
  resetWriteCounts();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dreaming-state-write-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

describe("writeMemoryCoreWorkspaceEntries", () => {
  it("writes only new daily state through the production light Dreaming sweep", async () => {
    const workspaceDir = await createWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-04-04.md"), "Alpha memory.\n", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-04-05.md"), "Beta memory.\n", "utf-8");
    const pluginConfig = {
      dreaming: {
        enabled: true,
        timezone: "UTC",
        storage: { mode: "separate", separateReports: false },
        phases: {
          light: { enabled: true, limit: 20, lookbackDays: 7 },
          rem: { enabled: false, limit: 0, lookbackDays: 7 },
        },
      },
    };
    const runSweep = () =>
      runDreamingSweepPhases({
        workspaceDir,
        pluginConfig,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
      });

    resetWriteCounts();
    await runSweep();
    expect(namespaceWriteCounts(DREAMING_DAILY_INGESTION_NAMESPACE)).toEqual({
      register: 2,
      delete: 0,
    });

    await fs.writeFile(path.join(memoryDir, "2026-04-03.md"), "Gamma memory.\n", "utf-8");
    resetWriteCounts();
    await runSweep();
    expect(namespaceWriteCounts(DREAMING_DAILY_INGESTION_NAMESPACE)).toEqual({
      register: 1,
      delete: 0,
    });

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toHaveLength(3);
  });

  it("writes all rows on first run, then skips unchanged rows on identical second run", async () => {
    const workspaceDir = await createWorkspace();
    const entries = [
      { key: "a.txt", value: { path: "a.txt", mtime: 1 } },
      { key: "b.txt", value: { path: "b.txt", mtime: 2 } },
      { key: "c.txt", value: { path: "c.txt", mtime: 3 } },
    ];

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries,
    });
    expect(writeCounts.register).toBe(3);
    expect(writeCounts.delete).toBe(0);

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries,
    });
    expect(writeCounts.register).toBe(0);
    expect(writeCounts.delete).toBe(0);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toEqual(expect.arrayContaining(entries));
    expect(stored).toHaveLength(3);
  });

  it("registers only the changed row when one value updates", async () => {
    const workspaceDir = await createWorkspace();
    const initial = [
      { key: "a.txt", value: { path: "a.txt", mtime: 1 } },
      { key: "b.txt", value: { path: "b.txt", mtime: 2 } },
    ];
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: initial,
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [
        { key: "a.txt", value: { path: "a.txt", mtime: 1 } },
        { key: "b.txt", value: { path: "b.txt", mtime: 99 } },
      ],
    });
    expect(writeCounts.register).toBe(1);
    expect(writeCounts.delete).toBe(0);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored.find((row) => row.key === "b.txt")?.value).toEqual({
      path: "b.txt",
      mtime: 99,
    });
  });

  it("preserves last-write-wins when duplicate keys return to the original value", async () => {
    const workspaceDir = await createWorkspace();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [{ key: "same.txt", value: { path: "same.txt", mtime: 1 } }],
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [
        { key: "same.txt", value: { path: "same.txt", mtime: 2 } },
        { key: "same.txt", value: { path: "same.txt", mtime: 1 } },
      ],
    });
    expect(writeCounts.register).toBe(2);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toEqual([{ key: "same.txt", value: { path: "same.txt", mtime: 1 } }]);
  });

  it("deletes only rows absent from the desired set", async () => {
    const workspaceDir = await createWorkspace();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [
        { key: "keep.txt", value: { path: "keep.txt", mtime: 1 } },
        { key: "drop.txt", value: { path: "drop.txt", mtime: 2 } },
      ],
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [{ key: "keep.txt", value: { path: "keep.txt", mtime: 1 } }],
    });
    expect(writeCounts.register).toBe(0);
    expect(writeCounts.delete).toBe(1);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toEqual([{ key: "keep.txt", value: { path: "keep.txt", mtime: 1 } }]);
  });

  it("does not rewrite rows belonging to a different workspace", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceA,
      entries: [{ key: "a.txt", value: { path: "a.txt", mtime: 1 } }],
    });
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceB,
      entries: [{ key: "b.txt", value: { path: "b.txt", mtime: 2 } }],
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceA,
      entries: [{ key: "a.txt", value: { path: "a.txt", mtime: 1 } }],
    });
    expect(writeCounts.register).toBe(0);
    expect(writeCounts.delete).toBe(0);

    const storedB = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceB,
    });
    expect(storedB).toEqual([{ key: "b.txt", value: { path: "b.txt", mtime: 2 } }]);
  });

  it("at namespace capacity, skips unchanged no-op passes without refreshing created_at", async () => {
    // Production opens at 50_000 rows. This reduced-cap stand-in proves the
    // same skip + created_at retention policy without writing tens of thousands
    // of rows or reopening a production namespace with a different limit.
    const capacity = 3;
    const capacityNamespace = "dreaming-workspace-capacity-noop";
    configureCountedDreamingState({
      maxEntriesByNamespace: { [capacityNamespace]: capacity },
    });
    vi.useFakeTimers();
    try {
      const workspaceDir = await createWorkspace();
      const oldest = { key: "oldest.txt", value: { path: "oldest.txt", mtime: 1 } };
      const mid = { key: "mid.txt", value: { path: "mid.txt", mtime: 2 } };
      const newest = { key: "newest.txt", value: { path: "newest.txt", mtime: 3 } };

      vi.setSystemTime(1_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest],
      });
      vi.setSystemTime(2_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid],
      });
      vi.setSystemTime(3_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, newest],
      });

      resetWriteCounts();
      vi.setSystemTime(4_000);
      // Unchanged pass must not refresh created_at via register().
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, newest],
      });
      expect(writeCounts.register).toBe(0);
      expect(writeCounts.delete).toBe(0);

      const stored = await readMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
      });
      expect(stored).toHaveLength(capacity);
      expect(stored.map((row) => row.key).toSorted()).toEqual(
        ["mid.txt", "newest.txt", "oldest.txt"].toSorted(),
      );
    } finally {
      vi.useRealTimers();
      configureCountedDreamingState();
    }
  });

  it("restores a desired row that capacity eviction removed after an equal skip", async () => {
    // Fill the namespace, keep two equal desired rows, replace the third with a
    // new key. Registering the new key can evict the oldest equal desired row
    // that the first pass already skipped; post-write reconcile must restore it
    // so the final stored set matches the full desired set (size <= capacity).
    const capacity = 3;
    const capacityNamespace = "dreaming-workspace-capacity-reconcile";
    configureCountedDreamingState({
      maxEntriesByNamespace: { [capacityNamespace]: capacity },
    });
    vi.useFakeTimers();
    try {
      const workspaceDir = await createWorkspace();
      const oldest = { key: "oldest.txt", value: { path: "oldest.txt", mtime: 1 } };
      const mid = { key: "mid.txt", value: { path: "mid.txt", mtime: 2 } };
      const newest = { key: "newest.txt", value: { path: "newest.txt", mtime: 3 } };
      const incoming = { key: "incoming.txt", value: { path: "incoming.txt", mtime: 4 } };

      vi.setSystemTime(1_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest],
      });
      vi.setSystemTime(2_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid],
      });
      vi.setSystemTime(3_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, newest],
      });

      resetWriteCounts();
      vi.setSystemTime(5_000);
      // Desired set still fits capacity: drop newest, add incoming, keep equals.
      // Without reconcile, register(incoming) evicts oldest after it was skipped.
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, incoming],
      });

      const stored = await readMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
      });
      expect(stored).toHaveLength(capacity);
      expect(stored.map((row) => row.key).toSorted()).toEqual(
        ["incoming.txt", "mid.txt", "oldest.txt"].toSorted(),
      );
      expect(stored.find((row) => row.key === "oldest.txt")?.value).toEqual(oldest.value);
      // At least one register for incoming; reconcile may issue one more for oldest.
      expect(writeCounts.register).toBeGreaterThanOrEqual(1);
      expect(writeCounts.delete).toBe(1);
    } finally {
      vi.useRealTimers();
      configureCountedDreamingState();
    }
  });

  it("restores desired rows when an early new registration would drop a later equal", async () => {
    const capacity = 3;
    const capacityNamespace = "dreaming-workspace-capacity-early-write";
    configureCountedDreamingState({
      maxEntriesByNamespace: { [capacityNamespace]: capacity },
    });
    vi.useFakeTimers();
    try {
      const workspaceDir = await createWorkspace();
      const oldest = { key: "oldest.txt", value: { path: "oldest.txt", mtime: 1 } };
      const mid = { key: "mid.txt", value: { path: "mid.txt", mtime: 2 } };
      const newest = { key: "newest.txt", value: { path: "newest.txt", mtime: 3 } };
      const incoming = { key: "incoming.txt", value: { path: "incoming.txt", mtime: 4 } };

      vi.setSystemTime(1_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest],
      });
      vi.setSystemTime(2_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid],
      });
      vi.setSystemTime(3_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, newest],
      });

      resetWriteCounts();
      vi.setSystemTime(6_000);
      // Early new key first: eviction can drop oldest before the loop reaches it.
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [incoming, oldest, mid],
      });

      const stored = await readMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
      });
      expect(stored.map((row) => row.key).toSorted()).toEqual(
        ["incoming.txt", "mid.txt", "oldest.txt"].toSorted(),
      );
      expect(stored).toHaveLength(capacity);
    } finally {
      vi.useRealTimers();
      configureCountedDreamingState();
    }
  });

  it("keeps this workspace's desired set under cross-workspace capacity pressure", async () => {
    const capacity = 3;
    const capacityNamespace = "dreaming-workspace-capacity-cross-ws";
    configureCountedDreamingState({
      maxEntriesByNamespace: { [capacityNamespace]: capacity },
    });
    vi.useFakeTimers();
    try {
      const workspaceA = await createWorkspace();
      const workspaceB = await createWorkspace();
      const a1 = { key: "a1.txt", value: { path: "a1.txt", mtime: 1 } };
      const a2 = { key: "a2.txt", value: { path: "a2.txt", mtime: 2 } };
      const b1 = { key: "b1.txt", value: { path: "b1.txt", mtime: 3 } };
      const a3 = { key: "a3.txt", value: { path: "a3.txt", mtime: 4 } };

      vi.setSystemTime(1_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir: workspaceA,
        entries: [a1],
      });
      vi.setSystemTime(2_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir: workspaceA,
        entries: [a1, a2],
      });
      vi.setSystemTime(3_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir: workspaceB,
        entries: [b1],
      });

      resetWriteCounts();
      vi.setSystemTime(4_000);
      // Namespace is full (a1,a2,b1). Writing a3 for A can evict a skipped equal
      // a1/a2; reconcile must leave A's full desired set intact.
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir: workspaceA,
        entries: [a1, a2, a3],
      });

      const storedA = await readMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir: workspaceA,
      });
      expect(storedA.map((row) => row.key).toSorted()).toEqual(
        ["a1.txt", "a2.txt", "a3.txt"].toSorted(),
      );
      expect(storedA).toHaveLength(3);
    } finally {
      vi.useRealTimers();
      configureCountedDreamingState();
    }
  });

  it("scales to thousands of rows with O(changes) registers on a second pass", async () => {
    // Maintainer-required representative scale proof: first pass writes N rows;
    // identical second pass must stay at zero registers; a third pass that
    // changes K rows must register O(K), not O(N).
    const rowCount = 2_000;
    const changeCount = 7;
    const scaleNamespace = "dreaming-workspace-scale-o-changes";
    const workspaceDir = await createWorkspace();
    const baseEntries = Array.from({ length: rowCount }, (_, index) => {
      const name = `file-${String(index).padStart(5, "0")}.txt`;
      return { key: name, value: { path: name, mtime: index + 1 } };
    });

    resetWriteCounts();
    const firstStarted = performance.now();
    await writeMemoryCoreWorkspaceEntries({
      namespace: scaleNamespace,
      workspaceDir,
      entries: baseEntries,
    });
    const firstMs = performance.now() - firstStarted;
    expect(writeCounts.register).toBe(rowCount);
    expect(writeCounts.delete).toBe(0);

    resetWriteCounts();
    const noopStarted = performance.now();
    await writeMemoryCoreWorkspaceEntries({
      namespace: scaleNamespace,
      workspaceDir,
      entries: baseEntries,
    });
    const noopMs = performance.now() - noopStarted;
    expect(writeCounts.register).toBe(0);
    expect(writeCounts.delete).toBe(0);

    const changedEntries = baseEntries.map((entry, index) =>
      index < changeCount
        ? { key: entry.key, value: { path: entry.key, mtime: entry.value.mtime + 1_000 } }
        : entry,
    );
    resetWriteCounts();
    const changeStarted = performance.now();
    await writeMemoryCoreWorkspaceEntries({
      namespace: scaleNamespace,
      workspaceDir,
      entries: changedEntries,
    });
    const changeMs = performance.now() - changeStarted;
    expect(writeCounts.register).toBe(changeCount);
    expect(writeCounts.delete).toBe(0);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: scaleNamespace,
      workspaceDir,
    });
    expect(stored).toHaveLength(rowCount);
    // No-op and small-change passes should stay well below a full rewrite budget.
    // Absolute ceilings leave headroom for CI load without accepting O(N) work.
    expect(noopMs).toBeLessThan(firstMs);
    expect(changeMs).toBeLessThan(firstMs);
    expect(noopMs).toBeLessThan(15_000);
    expect(changeMs).toBeLessThan(15_000);
  }, 120_000);
});
