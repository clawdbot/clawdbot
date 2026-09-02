import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

type AccountingParams = Parameters<typeof incrementCompactionCount>[0];

async function withAccountingFixture(
  body: (fixture: {
    params: AccountingParams;
    entry: InternalSessionEntry;
    cached: () => InternalSessionEntry | undefined;
    read: () => InternalSessionEntry | undefined;
    replace: (patch: Partial<InternalSessionEntry>) => Promise<unknown>;
    remove: () => Promise<unknown>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "compaction-accounting", scenario: "minimal" },
    async (state) => {
      const scope = {
        agentId: "main",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        sessionKey: "agent:main:compaction-accounting",
      };
      const entry: InternalSessionEntry = {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        updatedAt: 1,
        compactionCount: 0,
      };
      await replaceSessionEntry(scope, entry);
      const sessionStore = { [scope.sessionKey]: entry };
      await body({
        params: { ...scope, sessionEntry: entry, sessionStore, expectedSession: entry },
        entry,
        cached: () => sessionStore[scope.sessionKey],
        read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
        replace: (patch) => replaceSessionEntry(scope, { ...entry, ...patch }),
        remove: () =>
          applySessionEntryLifecycleMutation({
            agentId: scope.agentId,
            storePath: scope.storePath,
            removals: [{ sessionKey: scope.sessionKey }],
            skipMaintenance: true,
          }),
      });
    },
  );
}

describe("completed compaction accounting", () => {
  it.each([true, false])(
    "increments the authoritative count with caller cache=%s",
    async (withCache) => {
      await withAccountingFixture(async (fixture) => {
        await fixture.replace({ compactionCount: 7 });

        const count = await incrementCompactionCount({
          ...fixture.params,
          sessionEntry: withCache ? fixture.params.sessionEntry : undefined,
          sessionStore: withCache ? fixture.params.sessionStore : undefined,
          tokensAfter: 123,
        });

        expect(count).toBe(8);
        expect(fixture.read()).toMatchObject({
          sessionId: fixture.entry.sessionId,
          compactionCount: 8,
          totalTokens: 123,
        });
        expect(fixture.cached()?.compactionCount).toBe(withCache ? 8 : 0);
      });
    },
  );

  it.each([120, 40, 0, undefined])(
    "persists the latest private context snapshot (%s)",
    async (currentContextTokens) => {
      await withAccountingFixture(async (fixture) => {
        await fixture.replace({ totalTokens: 999, totalTokensFresh: true });

        expect(
          await incrementCompactionCount({ ...fixture.params, tokensAfter: currentContextTokens }),
        ).toBe(1);

        expect(fixture.read()).toMatchObject({
          compactionCount: 1,
          totalTokens: currentContextTokens ?? 999,
          totalTokensFresh: currentContextTokens !== undefined,
        });
      });
    },
  );

  it("records and clears byte-compaction progress with authoritative accounting", async () => {
    await withAccountingFixture(async (fixture) => {
      const latch = {
        activeBytes: 60_000,
        sessionId: fixture.entry.sessionId,
        maxBytes: 50_000,
      };

      expect(
        await incrementCompactionCount({
          ...fixture.params,
          transcriptByteCompactionLatch: latch,
        }),
      ).toBe(1);
      expect(fixture.read()?.transcriptByteCompactionLatch).toEqual(latch);

      expect(await incrementCompactionCount(fixture.params)).toBe(2);
      expect(fixture.read()?.transcriptByteCompactionLatch).toBeUndefined();
    });
  });

  it("does not overwrite a newer writer's count or token snapshot", async () => {
    await withAccountingFixture(async (fixture) => {
      await fixture.replace({
        activeWriterRunId: "new-writer",
        compactionCount: 7,
        totalTokens: 666,
        totalTokensFresh: true,
      });
      const before = fixture.read();

      expect(
        await incrementCompactionCount({
          ...fixture.params,
          expectedSession: { ...fixture.entry, activeWriterRunId: "old-writer" },
          tokensAfter: 123,
        }),
      ).toBeUndefined();

      expect(fixture.read()).toEqual(before);
    });
  });

  it("does not recreate a deleted row from a cached compaction result", async () => {
    await withAccountingFixture(async (fixture) => {
      await fixture.remove();

      expect(
        await incrementCompactionCount({
          ...fixture.params,
          expectedSession: undefined,
        }),
      ).toBeUndefined();
      expect(fixture.read()).toBeUndefined();
    });
  });

  it("preserves terminal owner authorization through run accounting", async () => {
    await withAccountingFixture(async (fixture) => {
      expect(
        await incrementCompactionCount({
          ...fixture.params,
          tokensAfter: 123,
          authorize: () => false,
        }),
      ).toBeUndefined();
      expect(fixture.read()?.compactionCount).toBe(0);
    });
  });

  it.each(["writer", "authority"] as const)(
    "does not write old compaction usage after terminal %s changes",
    async (change) => {
      await withAccountingFixture(async (fixture) => {
        await fixture.replace({
          activeWriterRunId: change === "writer" ? "new-writer" : "old-writer",
          totalTokens: 666,
          totalTokensFresh: true,
        });
        const before = fixture.read();

        await persistSessionUsageUpdate({
          agentId: fixture.params.agentId,
          storePath: fixture.params.storePath,
          sessionKey: fixture.params.sessionKey,
          cfg: {},
          expectedSession: { ...fixture.entry, activeWriterRunId: "old-writer" },
          currentContextSnapshot: { tokens: 123 },
          authorize: () => change !== "authority",
        });

        expect(fixture.read()).toEqual(before);
      });
    },
  );

  it.each([
    { name: "session", patch: { sessionId: "replacement-session" } },
    { name: "lifecycle", patch: { lifecycleRevision: "replacement-revision" } },
  ])("does not account compaction against a replaced $name", async ({ patch }) => {
    await withAccountingFixture(async (fixture) => {
      await fixture.replace(patch);
      const before = fixture.read();

      expect(
        await incrementCompactionCount({ ...fixture.params, tokensAfter: 123 }),
      ).toBeUndefined();

      expect(fixture.cached()).toBe(fixture.entry);
      expect(fixture.read()).toEqual(before);
    });
  });

  it("does not commit accounting when authority closes after the queued updater", async () => {
    await withAccountingFixture(async (fixture) => {
      let authorized = true;

      expect(
        await incrementCompactionCount({
          ...fixture.params,
          tokensAfter: 123,
          authorize: () => {
            queueMicrotask(() => {
              authorized = false;
            });
            return authorized;
          },
        }),
      ).toBeUndefined();

      expect(fixture.cached()).toBe(fixture.entry);
      expect(fixture.read()?.compactionCount).toBe(0);
      expect(fixture.read()?.totalTokens).toBeUndefined();
    });
  });
});
