// Memory Wiki tests cover crash-safe ChatGPT rollback behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rollbackChatGptImportRun } from "./chatgpt-import.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
  readMemoryWikiImportRunRecord,
  writeMemoryWikiImportRunRecord,
} from "./import-runs-state.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function configureDurableImportRunStore(stateDir: string): void {
  const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  configureMemoryWikiImportRunStateStore(
    createMemoryWikiImportRunStateStore(<T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
    ),
  );
}

async function seedCreatedRollback(params: {
  vaultRoot: string;
  runId: string;
  relativePath: string;
  contentHash?: string;
}): Promise<void> {
  await writeMemoryWikiImportRunRecord(params.vaultRoot, {
    version: 1,
    runId: params.runId,
    importType: "chatgpt",
    exportPath: "/tmp/chatgpt",
    sourcePath: "/tmp/chatgpt/conversations.json",
    appliedAt: "2026-04-10T10:00:00.000Z",
    conversationCount: 1,
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
    createdPaths: [
      {
        path: params.relativePath,
        ...(params.contentHash ? { contentHash: params.contentHash } : {}),
      },
    ],
    updatedPaths: [],
  });
}

afterEach(() => {
  configureMemoryWikiImportRunStateStore(undefined);
  resetPluginStateStoreForTests();
});

describe("ChatGPT import rollback recovery", () => {
  it("reconciles a crash after rename across a real SQLite reopen", async () => {
    const stateDir = await createTempDir("memory-wiki-chatgpt-state-");
    const { rootDir, config } = await createVault({ initialize: true });
    configureDurableImportRunStore(stateDir);
    const relativePath = "sources/retry.md";
    const targetPath = path.join(rootDir, relativePath);
    const imported = "# Imported\n";
    const edited = "# Edited after import\n";
    await fs.writeFile(targetPath, edited, "utf8");
    await seedCreatedRollback({
      vaultRoot: rootDir,
      runId: "chatgpt-crash-retry",
      relativePath,
      contentHash: createHash("sha256").update(imported, "utf8").digest("hex"),
    });

    const realRename = fs.rename;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await realRename(from, to);
      throw new Error("simulated process crash after rename");
    });
    await expect(
      rollbackChatGptImportRun({ config, runId: "chatgpt-crash-retry" }),
    ).rejects.toThrow("simulated process crash");
    renameSpy.mockRestore();
    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).resolves.toBeDefined();

    resetPluginStateStoreForTests();
    configureDurableImportRunStore(stateDir);
    const retried = await rollbackChatGptImportRun({ config, runId: "chatgpt-crash-retry" });
    expect(retried.alreadyRolledBack).toBe(false);
    expect(retried.preservedPaths).toHaveLength(1);
    const preserved = retried.preservedPaths[0];
    expect(preserved?.path).toBe(relativePath);
    await expect(
      fs.readFile(path.join(rootDir, preserved?.recoveryPath ?? ""), "utf8"),
    ).resolves.toBe(edited);

    await fs.writeFile(path.join(rootDir, preserved?.recoveryPath ?? ""), imported, "utf8");
    resetPluginStateStoreForTests();
    configureDurableImportRunStore(stateDir);
    const repeated = await rollbackChatGptImportRun({ config, runId: "chatgpt-crash-retry" });
    expect(repeated.alreadyRolledBack).toBe(true);
    expect(repeated.preservedPaths).toStrictEqual(retried.preservedPaths);
    await expect(
      fs.readFile(path.join(rootDir, preserved?.recoveryPath ?? ""), "utf8"),
    ).resolves.toBe(imported);
    await expect(
      readMemoryWikiImportRunRecord(rootDir, "chatgpt-crash-retry"),
    ).resolves.toMatchObject({
      rolledBackAt: expect.any(String),
      createdPaths: [{ path: relativePath, recoveryPaths: [preserved?.recoveryPath] }],
    });
  });

  it("queues the whole rollback behind an active vault mutation", async () => {
    const stateDir = await createTempDir("memory-wiki-chatgpt-lock-state-");
    const { rootDir, config } = await createVault({ initialize: true });
    configureDurableImportRunStore(stateDir);
    const relativePath = "sources/queued.md";
    const targetPath = path.join(rootDir, relativePath);
    const edited = "# Queued edit\n";
    await fs.writeFile(targetPath, edited, "utf8");
    await seedCreatedRollback({
      vaultRoot: rootDir,
      runId: "chatgpt-queued",
      relativePath,
      contentHash: "not-the-edited-content",
    });

    const lockEntered = deferred();
    const releaseLock = deferred();
    const holder = withMemoryWikiVaultMutation(rootDir, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;

    const rollbackQueued = deferred();
    const originalEnqueue = Object.getOwnPropertyDescriptor(KeyedAsyncQueue.prototype, "enqueue")
      ?.value as KeyedAsyncQueue["enqueue"];
    const enqueueSpy = vi
      .spyOn(KeyedAsyncQueue.prototype, "enqueue")
      .mockImplementation(function (this: KeyedAsyncQueue, key, task, hooks) {
        rollbackQueued.resolve();
        return originalEnqueue.call(this, key, task, hooks);
      });
    let rollback: ReturnType<typeof rollbackChatGptImportRun> | undefined;
    try {
      rollback = rollbackChatGptImportRun({ config, runId: "chatgpt-queued" });
      await rollbackQueued.promise;
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(edited);
      await expect(
        readMemoryWikiImportRunRecord(rootDir, "chatgpt-queued"),
      ).resolves.not.toHaveProperty("rolledBackAt");

      releaseLock.resolve();
      await expect(rollback).resolves.toMatchObject({
        alreadyRolledBack: false,
        preservedPaths: [{ path: relativePath }],
      });
      await holder;
    } finally {
      releaseLock.resolve();
      enqueueSpy.mockRestore();
      await Promise.allSettled([holder, ...(rollback ? [rollback] : [])]);
    }
  });

  it("preserves a created page recreated while rollback is removing it", async () => {
    const stateDir = await createTempDir("memory-wiki-chatgpt-recreated-state-");
    const { rootDir, config } = await createVault({ initialize: true });
    configureDurableImportRunStore(stateDir);
    const relativePath = "sources/recreated.md";
    const targetPath = path.join(rootDir, relativePath);
    const imported = "# Imported\n";
    const recreated = "# Recreated during rollback\n";
    await fs.writeFile(targetPath, imported, "utf8");
    await seedCreatedRollback({
      vaultRoot: rootDir,
      runId: "chatgpt-created-recreated",
      relativePath,
      contentHash: createHash("sha256").update(imported, "utf8").digest("hex"),
    });

    const realRename = fs.rename;
    let recreatedOnce = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (!recreatedOnce && path.basename(String(to)) === "content") {
        recreatedOnce = true;
        await fs.writeFile(from, recreated, "utf8");
      }
    });
    const result = await rollbackChatGptImportRun({
      config,
      runId: "chatgpt-created-recreated",
    });
    renameSpy.mockRestore();

    expect(recreatedOnce).toBe(true);
    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.preservedPaths).toHaveLength(1);
    await expect(
      fs.readFile(path.join(rootDir, result.preservedPaths[0]?.recoveryPath ?? ""), "utf8"),
    ).resolves.toBe(recreated);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked recovery directory without touching external files",
    async () => {
      const stateDir = await createTempDir("memory-wiki-chatgpt-recovery-link-state-");
      const externalDir = await createTempDir("memory-wiki-chatgpt-recovery-link-external-");
      const { rootDir, config } = await createVault({ initialize: true });
      configureDurableImportRunStore(stateDir);
      const runId = "chatgpt-recovery-link";
      const relativePath = "sources/existing.md";
      const snapshotRelativePath = "snapshots/existing.md";
      const imported = "# Imported\n";
      const runDir = path.join(rootDir, ".openclaw-wiki", "import-runs", runId);
      const snapshotPath = path.join(runDir, snapshotRelativePath);
      const targetPath = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, imported, "utf8");
      await fs.writeFile(targetPath, imported, "utf8");
      await writeMemoryWikiImportRunRecord(rootDir, {
        version: 1,
        runId,
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 1,
        createdCount: 0,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: [],
        updatedPaths: [
          {
            path: relativePath,
            snapshotPath: snapshotRelativePath,
            contentHash: createHash("sha256").update(imported, "utf8").digest("hex"),
          },
        ],
      });

      const slotPrefix = `updated-0-${createHash("sha256").update(relativePath).digest("hex")}-`;
      const externalSlot = path.join(externalDir, `${slotPrefix}ABCDEF`);
      const externalContent = path.join(externalSlot, "content");
      await fs.mkdir(externalSlot);
      await fs.writeFile(externalContent, imported, "utf8");
      await fs.symlink(externalDir, path.join(runDir, "recovered"), "dir");

      await expect(rollbackChatGptImportRun({ config, runId })).rejects.toThrow(
        "Memory Wiki rollback recovery path must not traverse symlinked directory",
      );
      await expect(fs.readFile(externalContent, "utf8")).resolves.toBe(imported);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(imported);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves leaf symlinks and non-regular paths without following them",
    async () => {
      const stateDir = await createTempDir("memory-wiki-chatgpt-special-state-");
      const externalDir = await createTempDir("memory-wiki-chatgpt-external-");
      const { rootDir, config } = await createVault({ initialize: true });
      configureDurableImportRunStore(stateDir);
      const symlinkRelativePath = "sources/linked.md";
      const directoryRelativePath = "sources/directory.md";
      const symlinkPath = path.join(rootDir, symlinkRelativePath);
      const directoryPath = path.join(rootDir, directoryRelativePath);
      const externalPath = path.join(externalDir, "outside.md");
      await fs.writeFile(externalPath, "# Outside\n", "utf8");
      await fs.symlink(externalPath, symlinkPath);
      await fs.mkdir(directoryPath);
      await fs.writeFile(path.join(directoryPath, "nested.md"), "# Nested\n", "utf8");
      await writeMemoryWikiImportRunRecord(rootDir, {
        version: 1,
        runId: "chatgpt-special-paths",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 2,
        createdCount: 2,
        updatedCount: 0,
        skippedCount: 0,
        createdPaths: [
          { path: symlinkRelativePath, contentHash: "not-the-symlink" },
          { path: directoryRelativePath, contentHash: "not-the-directory" },
        ],
        updatedPaths: [],
      });

      const result = await rollbackChatGptImportRun({
        config,
        runId: "chatgpt-special-paths",
      });
      expect(result.preservedPaths).toHaveLength(2);
      await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("# Outside\n");
      const symlinkRecovery = result.preservedPaths.find(
        (entry) => entry.path === symlinkRelativePath,
      );
      const directoryRecovery = result.preservedPaths.find(
        (entry) => entry.path === directoryRelativePath,
      );
      const recoveredSymlinkPath = path.join(rootDir, symlinkRecovery?.recoveryPath ?? "");
      const recoveredDirectoryPath = path.join(rootDir, directoryRecovery?.recoveryPath ?? "");
      await expect(fs.lstat(recoveredSymlinkPath)).resolves.toMatchObject({
        isSymbolicLink: expect.any(Function),
      });
      expect((await fs.lstat(recoveredSymlinkPath)).isSymbolicLink()).toBe(true);
      await expect(fs.readlink(recoveredSymlinkPath)).resolves.toBe(externalPath);
      expect((await fs.lstat(recoveredDirectoryPath)).isDirectory()).toBe(true);
      await expect(
        fs.readFile(path.join(recoveredDirectoryPath, "nested.md"), "utf8"),
      ).resolves.toBe("# Nested\n");
    },
  );
});
