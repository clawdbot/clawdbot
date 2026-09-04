import { createHook } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  readActualWorkspaceManifestImpl,
  readWorkspaceFileSnapshotWithLimit,
} from "./workspace-actual-manifest.js";
import { withWorkspaceHashMemo, workspaceStatIdentity } from "./workspace-hash-memo.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["metadata", "files"] as const)(
  "bounds pending promise resources while %s operations are blocked",
  async (phase) => {
    const root = await fs.realpath(tempDirs.make("workspace-inventory-pending-"));
    const files = Array.from({ length: 512 }, (_, index) => `file-${index}.txt`);
    await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), "inside")));
    const gate = createDeferred();
    let started = 0;
    const pause = async (target: unknown) => {
      if (String(target).startsWith(root + path.sep)) {
        started++;
        await gate.promise;
      }
    };
    if (phase === "metadata") {
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        await pause(args[0]);
        return await lstat(...args);
      });
    } else {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        await pause(args[0]);
        return await open(...args);
      });
    }
    const pendingPromises = new Set<number>();
    const hook = createHook({
      init(id, type) {
        if (type === "PROMISE") {
          pendingPromises.add(id);
        }
      },
      promiseResolve(id) {
        pendingPromises.delete(id);
      },
    }).enable();
    const scan = readActualWorkspaceManifestImpl({
      root,
      baseCommit: null,
      includePaths: new Set(files),
    });
    try {
      await vi.waitFor(() => expect(started).toBe(4));
      // Observe queued resources, not limiter internals: idle paths must not
      // each retain a promise graph while the active I/O is blocked.
      expect(pendingPromises.size).toBeLessThan(files.length);
    } finally {
      hook.disable();
      gate.resolve();
      await Promise.allSettled([scan]);
    }
    expect((await scan).manifest.entries).toHaveLength(files.length);
  },
);

it("joins bounded file readers after a workspace file moves outside its root", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-readers-"));
  const outside = await fs.realpath(tempDirs.make("workspace-inventory-outside-"));
  const files = Array.from({ length: 9 }, (_, index) => `file-${index}.txt`);
  await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), "inside")));
  await fs.writeFile(path.join(outside, "target.txt"), "outside");
  const open = fs.open.bind(fs);
  const gates: Array<ReturnType<typeof createDeferred<void>>> = [];
  const gatedPaths: string[] = [];
  const firstClosed = createDeferred();
  let closed = 0;
  let releasing = false;
  const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!String(args[0]).startsWith(root + path.sep)) {
      return handle;
    }
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      await close();
      closed++;
      firstClosed.resolve();
    });
    if (!releasing) {
      const gate = createDeferred();
      gates.push(gate);
      gatedPaths.push(String(args[0]));
      await gate.promise;
    }
    return handle;
  });
  const scan = readActualWorkspaceManifestImpl({
    root,
    baseCommit: null,
    includePaths: new Set(files),
  });
  let settled = false;
  void scan.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    await fs.rename(gatedPaths[0]!, path.join(outside, "moved.txt"));
    await fs.symlink(path.join(outside, "target.txt"), gatedPaths[0]!);
    gates[0]!.resolve();
    await firstClosed.promise;
    expect(settled).toBe(false);
    expect(opened).toHaveBeenCalledTimes(4);
  } finally {
    releasing = true;
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled([scan]);
  }
  await expect(scan).rejects.toThrow();
  expect(opened).toHaveBeenCalledTimes(4);
  expect(closed).toBe(4);
});

it("joins the admitted metadata batch and preserves its first error", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-metadata-"));
  const files = Array.from({ length: 9 }, (_, index) => `file-${index}.txt`);
  await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), "inside")));
  const lstat = fs.lstat.bind(fs);
  const gates: Array<ReturnType<typeof createDeferred<void>>> = [];
  const failed = createDeferred();
  const error = new Error("inventory metadata unavailable");
  let releasing = false;
  let started = 0;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(root + path.sep)) {
      const first = started++ === 0;
      if (!releasing) {
        const gate = createDeferred();
        gates.push(gate);
        await gate.promise;
      }
      if (first) {
        failed.resolve();
        throw error;
      }
    }
    return await lstat(...args);
  });
  const scan = readActualWorkspaceManifestImpl({
    root,
    baseCommit: null,
    includePaths: new Set(files),
  });
  let settled = false;
  void scan.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    gates[0]!.resolve();
    await failed.promise;
    expect(settled).toBe(false);
    expect(started).toBe(4);
  } finally {
    releasing = true;
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled([scan]);
  }
  await expect(scan).rejects.toBe(error);
  expect(started).toBe(4);
});

it("preserves bottom-up directory membership and canonical output across input orders", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-membership-"));
  for (const file of [
    "cache/nested/node_modules/pkg/file.js",
    "mixed/child/keep.txt",
    "mixed/node_modules/pkg/file.js",
    "Zebra.txt",
    "älg.txt",
  ]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file);
  }
  await fs.mkdir(path.join(root, "preserved/node_modules"), { recursive: true });
  await fs.symlink("../outside", path.join(root, "escaping"));
  const included = [
    "cache",
    "cache/nested",
    "cache/nested/node_modules",
    "mixed",
    "mixed/child",
    "mixed/child/keep.txt",
    "mixed/node_modules",
    "preserved",
    "preserved/node_modules",
    "Zebra.txt",
    "älg.txt",
    "escaping",
    "absent",
  ];
  const capture = (paths: string[]) =>
    readActualWorkspaceManifestImpl({
      root,
      baseCommit: null,
      includePaths: new Set(paths),
      preserveDirectories: new Set(["preserved"]),
    });
  const first = await capture(included);
  const reversed = await capture(included.toReversed());
  expect(first.manifest.directories).toEqual(["mixed", "mixed/child", "preserved"]);
  expect(first.manifest.entries.map((entry) => entry.path).toSorted()).toEqual([
    "Zebra.txt",
    "mixed/child/keep.txt",
    "älg.txt",
  ]);
  expect(reversed).toEqual(first);
});

it("reserves aggregate inventory bytes even when every file hits the hash memo", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-byte-budget-"));
  const memo = new Map<string, string>();
  const metrics = { contentHashCount: 0, contentHashDurationMs: 0, memoHitCount: 0 };
  for (const file of ["first.bin", "second.bin"]) {
    const target = path.join(root, file);
    await fs.writeFile(target, "");
    await fs.truncate(target, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES / 2 + 1);
    memo.set(
      workspaceStatIdentity("gateway", await fs.stat(target, { bigint: true })),
      "a".repeat(64),
    );
  }
  await expect(
    withWorkspaceHashMemo(
      memo,
      () => readActualWorkspaceManifestImpl({ root, baseCommit: null }),
      metrics,
    ),
  ).rejects.toThrow("eligible byte limit");
  expect(metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
});

it.each(["inventory", "fixed limit"] as const)(
  "preserves the %s diagnosis when a file grows during its read",
  async (mode) => {
    const root = await fs.realpath(tempDirs.make("workspace-inventory-growing-file-"));
    const target = path.join(root, "growing.txt");
    await fs.writeFile(target, "a");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === target) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
          await fs.appendFile(target, "b");
          return await read(...readArgs);
        });
      }
      return handle;
    });
    if (mode === "inventory") {
      await expect(readActualWorkspaceManifestImpl({ root, baseCommit: null })).rejects.toThrow(
        "file changed while it was being read",
      );
    } else {
      await expect(readWorkspaceFileSnapshotWithLimit(target, 1, root)).resolves.toEqual({
        type: "unsupported",
      });
    }
  },
);
