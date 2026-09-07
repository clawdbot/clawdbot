import path from "node:path";
import { setImmediate } from "node:timers";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, test } from "vitest";
import {
  clearMemoryCoreWorkspaceNamespace,
  configureMemoryCoreDreamingState,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    configureMemoryCoreDreamingState(() => {
      throw new Error("memory workspace test store is closed");
    });
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

function createFixture() {
  const root = tempDirs.make("memory-workspace-state-");
  const env = { OPENCLAW_STATE_DIR: root };
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env }),
  );
  const scope = { namespace: "workspace-progress", workspaceDir: path.join(root, "workspace") };
  return {
    scope,
    foreignWorkspace: { ...scope, workspaceDir: path.join(root, "foreign-workspace") },
    foreignNamespace: { ...scope, namespace: "workspace-other" },
    database: openOpenClawStateDatabase({ env }),
  };
}

async function readValues(scope: ReturnType<typeof createFixture>["scope"]) {
  return Object.fromEntries(
    (await readMemoryCoreWorkspaceEntries(scope)).map(({ key, value }) => [key, value]),
  );
}

test.each(["replacement", "cleanup", "clear"] as const)(
  "workspace %s lets queued event-loop work observe committed progress",
  async (phase) => {
    const { scope, foreignWorkspace, foreignNamespace, database } = createFixture();
    const originals = Array.from({ length: 64 }, (_, index) => ({
      key: `entry-${index}`,
      value: "old",
    }));
    const initial =
      phase === "replacement" ? [...originals, { key: "stale", value: "old" }] : originals;
    await writeMemoryCoreWorkspaceEntries({ ...scope, entries: initial });
    await writeMemoryCoreWorkspaceEntry({ ...foreignWorkspace, key: "entry-0", value: "foreign" });
    await writeMemoryCoreWorkspaceEntry({ ...foreignNamespace, key: "stale", value: "other" });
    const entries =
      phase === "clear"
        ? []
        : phase === "replacement"
          ? originals.map(({ key }) => ({ key, value: "new" }))
          : [{ key: "retained", value: "new" }];
    let completed = false;
    const observation = new Promise<{
      completed: boolean;
      transactionOpen: boolean;
      entries: Array<{ key: string; value: string }>;
    }>((resolve, reject) => {
      setImmediate(() => {
        const completedAtCallback = completed;
        const transactionOpen = database.db.isTransaction;
        void readMemoryCoreWorkspaceEntries<string>(scope).then(
          (current) =>
            resolve({ completed: completedAtCallback, transactionOpen, entries: current }),
          reject,
        );
      });
    });
    const operation = (
      phase === "clear"
        ? clearMemoryCoreWorkspaceNamespace(scope)
        : writeMemoryCoreWorkspaceEntries({ ...scope, entries })
    ).then(() => {
      completed = true;
    });
    try {
      const [, observed] = await Promise.all([operation, observation]);
      expect(await readValues(scope)).toEqual(
        Object.fromEntries(entries.map(({ key, value }) => [key, value])),
      );
      expect(await readValues(foreignWorkspace)).toEqual({ "entry-0": "foreign" });
      expect(await readValues(foreignNamespace)).toEqual({ stale: "other" });

      expect(observed).toMatchObject({ completed: false, transactionOpen: false });
      if (phase === "replacement") {
        const updated = observed.entries.filter((entry) => entry.value === "new");
        expect(updated.length).toBeGreaterThan(0);
        expect(updated.length).toBeLessThan(entries.length);
        // Obsolete rows cannot disappear before every replacement write commits.
        expect(observed.entries).toContainEqual({ key: "stale", value: "old" });
      } else {
        const remaining = observed.entries.filter((entry) => entry.value === "old");
        expect(remaining.length).toBeGreaterThan(0);
        expect(remaining.length).toBeLessThan(originals.length);
        if (phase === "cleanup") {
          expect(observed.entries).toContainEqual({ key: "retained", value: "new" });
        }
      }
    } finally {
      await Promise.allSettled([operation, observation]);
    }
  },
);

test("a rejected replacement preserves its committed prefix and skips cleanup", async () => {
  const { scope, foreignWorkspace, foreignNamespace } = createFixture();
  await writeMemoryCoreWorkspaceEntries({
    ...scope,
    entries: [
      { key: "first", value: "old" },
      { key: "tail", value: "old" },
      { key: "stale", value: "old" },
    ],
  });
  await writeMemoryCoreWorkspaceEntry({ ...foreignWorkspace, key: "first", value: "foreign" });
  await writeMemoryCoreWorkspaceEntry({ ...foreignNamespace, key: "stale", value: "other" });

  await expect(
    writeMemoryCoreWorkspaceEntries<unknown>({
      ...scope,
      entries: [
        { key: "first", value: "new" },
        { key: "invalid", value: 1n },
        { key: "tail", value: "unreached" },
      ],
    }),
  ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "register" });
  expect(await readValues(scope)).toEqual({ first: "new", tail: "old", stale: "old" });
  expect(await readValues(foreignWorkspace)).toEqual({ first: "foreign" });
  expect(await readValues(foreignNamespace)).toEqual({ stale: "other" });

  await writeMemoryCoreWorkspaceEntry({ ...scope, key: "tail", value: "scalar" });
  expect(await readValues(scope)).toEqual({ first: "new", tail: "scalar", stale: "old" });
});
