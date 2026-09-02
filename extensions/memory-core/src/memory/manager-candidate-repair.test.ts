import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("automatic candidates during provenance repair", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([false, true])(
    "returns promptly while a large rebuild is pending (startup catch-up: %s)",
    async (startupCatchup) => {
      const projectKey = "github.com/example/project";
      await fs.writeFile(
        path.join(fixture.paths.workspace, "MEMORY.md"),
        `- Keep the release local. <!-- trigger: release local --> <!-- project: ${projectKey} -->\n`,
      );
      await Promise.all(
        Array.from({ length: 256 }, (_, index) =>
          fs.writeFile(
            path.join(fixture.paths.memory, `entry-${index}.md`),
            `# Entry ${index}\nSynthetic memory content ${index}.\n`,
          ),
        ),
      );
      const cfg = fixture.createConfig({
        provider: "batch-wide-test",
        batchEnabled: true,
        vectorEnabled: false,
        sources: startupCatchup ? ["memory", "sessions"] : ["memory"],
        sessionMemory: startupCatchup,
      });
      if (startupCatchup) {
        await fixture.seedSessionTranscript({
          sessionId: "legacy-session",
          messages: [{ role: "user", timestamp: 1, content: "Remember the release preference." }],
        });
      }
      const initial = await fixture.getFreshManager(cfg, "cli");
      await initial.sync({ reason: "cli", force: true });
      const db = Reflect.get(initial, "db") as DatabaseSync;
      // Older indexes have neither classified provenance nor a chunking version.
      db.exec("DELETE FROM memory_index_chunk_provenance; DELETE FROM memory_embedding_cache");
      const row = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get() as { value: string };
      const meta = JSON.parse(row.value) as MemoryIndexMeta;
      delete meta.provenanceVersion;
      delete meta.chunkingVersion;
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
        JSON.stringify(meta),
      );
      await initial.close();

      const gate = createDeferred<void>();
      fixture.provider.providerRuntimeBatchGate = gate.promise;
      const upgraded = await fixture.getFreshManager(cfg);
      const candidates: Promise<unknown>[] = [];
      try {
        expect(upgraded.status().custom?.indexIdentity).toMatchObject({
          status: "mismatched",
          reason: "index provenance classifier changed",
        });
        if (startupCatchup) {
          await vi.waitFor(() => expect(fixture.provider.providerRuntimeActiveBatchCalls).toBe(1), {
            timeout: 10_000,
          });
        }
        let completed = 0;
        for (const lookup of [
          () => upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
          () => upgraded.listTriggerCandidates({ activeProjectKeys: [projectKey] }),
        ]) {
          candidates.push(
            lookup().then((results) => {
              completed += 1;
              return results;
            }),
          );
        }
        await vi.waitFor(() => expect(completed).toBe(2));
        expect(await Promise.all(candidates)).toEqual([[], []]);
        await vi.waitFor(() => expect(fixture.provider.providerRuntimeActiveBatchCalls).toBe(1), {
          timeout: 10_000,
        });
        expect(upgraded.status().dirty).toBe(true);
      } finally {
        gate.resolve();
        await Promise.allSettled(candidates);
      }
      await upgraded.sync({ reason: "test-repair-complete" });
      expect(upgraded.status().dirty).toBe(false);
      const expected = [
        expect.objectContaining({
          projectKey,
          triggers: "release local",
          provenance: expect.objectContaining({ originClass: "agent" }),
        }),
      ];
      expect(
        await upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
      ).toEqual(expected);
      expect(await upgraded.listTriggerCandidates({ activeProjectKeys: [projectKey] })).toEqual(
        expected,
      );
    },
  );

  it("drains admitted candidate repair retries before closing the database", async () => {
    const projectKey = "github.com/example/project";
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      `- Preserve the release preference. <!-- trigger: release local --> <!-- project: ${projectKey} -->\n`,
    );
    const ftsConfig = fixture.createConfig({ provider: "none", vectorEnabled: false });
    const initial = await fixture.getFreshManager(ftsConfig, "cli");
    await initial.sync({ reason: "cli", force: true });
    // The existing migration will invalidate these sources on the next open.
    const initialDb = Reflect.get(initial, "db") as DatabaseSync;
    initialDb.exec("DELETE FROM memory_index_chunk_provenance");
    await initial.close();

    const initialization = createDeferred<void>();
    const retryStarted = createDeferred<void>();
    const retry = createDeferred<void>();
    fixture.provider.providerInitGate = initialization.promise;
    fixture.provider.providerCreationFailure = "local";
    const upgraded = await fixture.getFreshManager(
      fixture.createConfig({ provider: "local", vectorEnabled: false }),
      "cli",
    );
    const owner = upgraded as unknown as {
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const runSync = owner.runSync.bind(upgraded);
    let pendingRetry: Promise<void> | undefined;
    const retryGate = vi.spyOn(owner, "runSync").mockImplementation((params) => {
      retryStarted.resolve();
      pendingRetry = retry.promise.then(() => runSync(params));
      return pendingRetry;
    });
    // This is the same public sync admission used by detached startup catch-up.
    // Attach rejection handling immediately; its failed initialization is expected.
    const startup = upgraded.sync({ reason: "session-startup-catchup" });
    const startupOutcome = startup.then(
      () => undefined,
      (error: unknown) => error,
    );
    let closing: Promise<void> | undefined;
    let closeSettled = false;
    try {
      await vi.waitFor(() => expect(fixture.provider.providerCalls.at(-1)?.provider).toBe("local"));
      await expect(
        upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
      ).resolves.toEqual([]);
      closing = upgraded.close().then(() => {
        closeSettled = true;
      });
      // Let close enter its drain before the already-running sync fails. This
      // reproduces the original execution order without a timing-based sleep.
      await Promise.resolve();
      initialization.resolve();
      await retryStarted.promise;
      // Give teardown a turn to finish while the admitted retry remains gated.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closeSettled).toBe(false);
      retry.resolve();
      await closing;
      expect(await startupOutcome).toBeInstanceOf(Error);

      // Observable persistence proof: close did not merely cancel or abandon
      // the retry; its classified candidates survive a fresh manager open.
      const reopened = await fixture.getFreshManager(ftsConfig, "cli");
      expect(
        await reopened.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
      ).toEqual([
        expect.objectContaining({
          projectKey,
          triggers: "release local",
          provenance: expect.objectContaining({ originClass: "agent" }),
        }),
      ]);
    } finally {
      initialization.resolve();
      retry.resolve();
      await startupOutcome;
      await pendingRetry?.catch(() => undefined);
      await closing;
      await upgraded.close();
      retryGate.mockRestore();
    }
  });
});
