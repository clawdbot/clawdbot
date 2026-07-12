// Ingress queue tests cover durable queueing for inbound channel messages.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue, createStateDirEnv } from "./ingress-queue.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-queue-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("channel ingress queue", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("opens a custom state database without copying the full process env", async () => {
    const baseEnv: NodeJS.ProcessEnv = {
      HOME: "/home/openclaw",
      PATH: "/usr/local/bin:/usr/bin",
    };
    for (let index = 0; index < 10_000; index += 1) {
      baseEnv[`KUBERNETES_SERVICE_${index}`] = "tcp://10.0.0.1:443";
    }
    const inheritedEnv = new Proxy(baseEnv, {
      ownKeys() {
        throw new Error("inherited env should not be enumerated");
      },
    });

    await withTempState(async (stateDir) => {
      const env = createStateDirEnv(stateDir, inheritedEnv);

      expect(env.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(env.HOME).toBe("/home/openclaw");
      expect(Object.getPrototypeOf(env)).toBe(inheritedEnv);
      expect(Object.keys(env)).toEqual(["OPENCLAW_STATE_DIR"]);

      const database = openOpenClawStateDatabase({ env });
      expect(database.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
    });
  });

  it("deduplicates pending and completed ingress events", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<
        { text: string },
        { source: string },
        { handledBy: string }
      >({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 100,
      });

      const accepted = await queue.enqueue(
        "event-1",
        { text: "first" },
        { metadata: { source: "fixture" }, receivedAt: 50 },
      );
      const pending = await queue.enqueue("event-1", { text: "duplicate" });
      await queue.complete("event-1", { metadata: { handledBy: "worker" }, completedAt: 150 });
      const completed = await queue.enqueue("event-1", { text: "late duplicate" });

      expect(accepted.kind).toBe("accepted");
      expect(pending.kind).toBe("pending");
      if (pending.kind !== "pending") {
        throw new Error(`Expected pending duplicate, got ${pending.kind}`);
      }
      expect(pending.record.payload).toEqual({ text: "first" });
      expect(completed).toEqual({
        kind: "completed",
        duplicate: true,
        record: {
          id: "event-1",
          channelId: "test",
          accountId: "account",
          queueName: JSON.stringify(["test", "account"]),
          completedAt: 150,
          metadata: { handledBy: "worker" },
        },
      });
      expect(await queue.listPending()).toEqual([]);

      expect(
        await queue.complete("missing-event", {
          metadata: { handledBy: "late-worker" },
          completedAt: 200,
        }),
      ).toBe(true);
      expect(await queue.enqueue("missing-event", { text: "late duplicate" })).toMatchObject({
        kind: "completed",
        duplicate: true,
        record: {
          id: "missing-event",
          completedAt: 200,
          metadata: { handledBy: "late-worker" },
        },
      });

      await queue.enqueue(" spaced-event ", { text: "spaced" });
      expect(await queue.complete(" spaced-event ", { completedAt: 250 })).toBe(true);
      expect(await queue.enqueue("spaced-event", { text: "duplicate" })).toMatchObject({
        kind: "completed",
        duplicate: true,
        record: { id: "spaced-event", completedAt: 250 },
      });
    });
  });

  it("keeps channel and account queue identities unambiguous", async () => {
    await withTempState(async (stateDir) => {
      const first = createChannelIngressQueue<{ text: string }>({
        channelId: "a",
        accountId: "b:c",
        stateDir,
      });
      const second = createChannelIngressQueue<{ text: string }>({
        channelId: "a:b",
        accountId: "c",
        stateDir,
      });

      expect(await first.enqueue("same-id", { text: "first" })).toMatchObject({
        kind: "accepted",
      });
      expect(await second.enqueue("same-id", { text: "second" })).toMatchObject({
        kind: "accepted",
      });

      await first.complete("same-id");

      expect(await first.enqueue("same-id", { text: "first duplicate" })).toMatchObject({
        kind: "completed",
      });
      expect(await second.enqueue("same-id", { text: "second duplicate" })).toMatchObject({
        kind: "pending",
        record: { payload: { text: "second" } },
      });
    });
  });

  it("can bound pending scans and prune stale pending rows", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ index: number }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("0002", { index: 2 });
      await queue.enqueue("0001", { index: 1 });
      await queue.enqueue("0003", { index: 3 });

      expect(
        (await queue.listPending({ limit: 2, orderBy: "id" })).map((record) => record.id),
      ).toEqual(["0001", "0002"]);
      expect(await queue.prune({ pendingTtlMs: 3, pendingMaxEntries: 1, now: 7 })).toBe(2);
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "0003",
      ]);
    });
  });

  it("does not prune protected rows while enforcing max-entry limits", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ index: number }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("z", { index: 1 });
      await queue.enqueue("a", { index: 2 });

      expect(await queue.prune({ pendingMaxEntries: 1, protectIds: ["a"] })).toBe(0);
      expect(
        (await queue.listPending({ limit: "all", orderBy: "id" })).map((row) => row.id),
      ).toEqual(["a", "z"]);
    });
  });

  it("prunes max-entry overflow across bounded batches", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ index: number }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      for (let index = 0; index < 520; index += 1) {
        await queue.enqueue(String(index).padStart(4, "0"), { index });
      }

      expect(await queue.prune({ pendingMaxEntries: 2 })).toBe(518);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "0518",
        "0519",
      ]);
    });
  });

  it("claims, releases, and skips blocked lanes", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("a", { text: "blocked" }, { laneKey: "chat-1", receivedAt: 1 });
      await queue.enqueue("b", { text: "open" }, { laneKey: "chat-2", receivedAt: 2 });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        blockedLaneKeys: ["chat-1"],
      });

      expect(claimed?.id).toBe("b");
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }
      expect(await queue.release(claimed, { lastError: "retry", releasedAt: 20 })).toBe(true);
      expect((await queue.listPending()).find((record) => record.id === "b")).toMatchObject({
        attempts: 1,
        lastAttemptAt: 20,
        lastError: "retry",
      });

      const reclaimed = await queue.claim("b", { ownerId: "replacement" });
      if (!reclaimed) {
        throw new Error("Expected the released ingress event to be claimable");
      }
      expect(await queue.release(reclaimed, { recordAttempt: false, releasedAt: 30 })).toBe(true);
      expect((await queue.listPending()).find((record) => record.id === "b")).toMatchObject({
        attempts: 1,
        lastAttemptAt: 20,
        lastError: "retry",
        updatedAt: 30,
      });
    });
  });

  it("claims next pending row by id when requested", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("0002", { text: "second" }, { receivedAt: 1 });
      await queue.enqueue("0001", { text: "first" }, { receivedAt: 2 });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        orderBy: "id",
      });

      expect(claimed?.id).toBe("0001");
    });
  });

  it("claims next only from candidate ids when provided", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("a", { text: "outside snapshot" }, { receivedAt: 1 });
      await queue.enqueue("b", { text: "inside snapshot" }, { receivedAt: 2 });

      expect(
        await queue.claimNext({
          ownerId: "worker",
          candidateIds: ["b"],
        }),
      ).toMatchObject({ id: "b" });
      expect(await queue.claimNext({ candidateIds: [] })).toBeNull();
    });
  });

  it("derives missing lane keys before claiming next", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ lane: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("a", { lane: "blocked" }, { receivedAt: 1 });
      await queue.enqueue("b", { lane: "open" }, { receivedAt: 2 });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        blockedLaneKeys: ["blocked"],
        deriveLaneKey: (record) => record.payload.lane,
      });

      expect(claimed?.id).toBe("b");
      expect(claimed?.laneKey).toBe("open");
      expect(
        (await queue.listPending()).find((record) => record.id === "a")?.laneKey,
      ).toBeUndefined();
    });
  });

  it("blocks lanes claimed by candidate rows before claiming later candidates", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createChannelIngressQueue<{ lane: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => clock++,
      });

      await queue.enqueue("a", { lane: "chat-1" }, { receivedAt: 1 });
      await queue.enqueue("b", { lane: "chat-1" }, { receivedAt: 2 });
      await queue.enqueue("c", { lane: "chat-2" }, { receivedAt: 3 });
      await queue.claim("a", { ownerId: "sibling-worker" });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds: ["a", "b", "c"],
        orderBy: "id",
        deriveLaneKey: (record) => record.payload.lane,
      });

      expect(claimed?.id).toBe("c");
      expect(claimed?.laneKey).toBe("chat-2");
      const sameLanePending = (await queue.listPending()).find((record) => record.id === "b");
      expect(sameLanePending?.laneKey).toBeUndefined();
    });
  });

  it("requires claim tokens before mutating claimed rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("event-1", { text: "claimed" });
      const claimed = await queue.claim("event-1", { ownerId: "worker" });
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(await queue.complete("event-1")).toBe(false);
      expect(await queue.release("event-1")).toBe(false);
      expect(await queue.fail("event-1", { reason: "stale-handler" })).toBe(false);
      expect(await queue.delete("event-1")).toBe(false);

      expect(await queue.complete(claimed, { completedAt: 20 })).toBe(true);
      const duplicate = await queue.enqueue("event-1", { text: "duplicate" });
      expect(duplicate.kind).toBe("completed");
    });
  });

  it("refreshes claimed rows only with the active claim token", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("event-1", { text: "claimed" });
      const claimed = await queue.claim("event-1", { ownerId: "worker" });
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(await queue.refreshClaim?.(claimed, { refreshedAt: 20 })).toBe(true);
      expect(
        (await queue.listClaims()).map((claim) => ({
          id: claim.id,
          claimedAt: claim.claim.claimedAt,
          updatedAt: claim.updatedAt,
        })),
      ).toEqual([{ id: "event-1", claimedAt: 20, updatedAt: 20 }]);

      expect(
        await queue.refreshClaim?.(
          { id: "event-1", claim: { token: "wrong" } },
          {
            refreshedAt: 30,
          },
        ),
      ).toBe(false);
      expect((await queue.listClaims())[0]?.claim.claimedAt).toBe(20);
    });
  });

  it("does not let old claim tokens refresh recovered and reclaimed rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("event-1", { text: "claimed" });
      const oldClaim = await queue.claim("event-1", { ownerId: "worker-1" });
      if (!oldClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      expect(await queue.recoverStaleClaims({ staleMs: 5, now: 20 })).toBe(1);
      const newClaim = await queue.claim("event-1", { ownerId: "worker-2" });
      if (!newClaim) {
        throw new Error("Expected reclaimed ingress event");
      }

      expect(await queue.refreshClaim?.(oldClaim, { refreshedAt: 30 })).toBe(false);
      expect(await queue.refreshClaim?.(newClaim, { refreshedAt: 40 })).toBe(true);
      expect((await queue.listClaims())[0]?.claim).toMatchObject({
        ownerId: "worker-2",
        claimedAt: 40,
      });
    });
  });

  it("does not recover a claim refreshed after stale recovery snapshots it", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("event-1", { text: "claimed" });
      const claimed = await queue.claim("event-1", { ownerId: "worker" });
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(
        await queue.recoverStaleClaims({
          staleMs: 5,
          now: 20,
          shouldRecover: async (claim) => {
            expect(claim.id).toBe("event-1");
            expect(await queue.refreshClaim?.(claim, { refreshedAt: 20 })).toBe(true);
            return true;
          },
        }),
      ).toBe(0);
      expect((await queue.listPending()).map((record) => record.id)).toEqual([]);
      expect((await queue.listClaims())[0]?.claim).toMatchObject({
        ownerId: "worker",
        claimedAt: 20,
      });
    });
  });

  it("recovers stale claims and prunes completed or failed rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });

      await queue.enqueue("old", { text: "old" });
      await queue.enqueue("keep", { text: "keep" });
      const old = await queue.claim("old", { ownerId: "worker" });
      const keep = await queue.claim("keep", { ownerId: "worker" });
      if (!keep) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(
        await queue.recoverStaleClaims({
          staleMs: 5,
          now: 20,
          shouldRecover: (claim) => claim.id === old?.id,
        }),
      ).toBe(1);
      expect((await queue.listPending()).map((record) => record.id)).toEqual(["old"]);
      expect((await queue.listClaims()).map((record) => record.id)).toEqual(["keep"]);

      await queue.complete("old", { completedAt: 25 });
      await queue.fail(keep, { reason: "poison", message: "bad", failedAt: 25 });
      await queue.enqueue("retry", { text: "retry" });
      await queue.release("retry", { lastError: "stale retry text", releasedAt: 26 });
      await queue.complete("retry", { completedAt: 27 });

      const database = openOpenClawStateDatabase({
        env: createStateDirEnv(stateDir),
      });
      const kysely = getNodeSqliteKysely<ChannelIngressTestDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("channel_ingress_events")
          .select(["event_id", "payload_json", "metadata_json", "last_attempt_at", "last_error"])
          .where("event_id", "in", ["old", "keep", "retry"])
          .orderBy("event_id", "asc"),
      ).rows;
      expect(rows).toEqual([
        {
          event_id: "keep",
          last_attempt_at: null,
          last_error: "bad",
          metadata_json: null,
          payload_json: "null",
        },
        {
          event_id: "old",
          last_attempt_at: null,
          last_error: null,
          metadata_json: null,
          payload_json: "null",
        },
        {
          event_id: "retry",
          last_attempt_at: null,
          last_error: null,
          metadata_json: null,
          payload_json: "null",
        },
      ]);

      expect(await queue.prune({ completedTtlMs: 10, failedTtlMs: 10, now: 40 })).toBe(3);
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    });
  });

  describe("corrupt JSON resilience", () => {
    function insertCorruptRow(
      stateDir: string,
      queueName: string,
      eventId: string,
      overrides: Partial<{
        payload_json: string;
        metadata_json: string | null;
        completed_metadata_json: string | null;
        status: string;
        claim_token: string;
        claim_owner: string;
        claimed_at: number;
        completed_at: number;
      }>,
    ) {
      const { db } = openOpenClawStateDatabase({
        env: createStateDirEnv(stateDir),
      });
      const kysely = getNodeSqliteKysely<ChannelIngressTestDatabase>(db);
      const claimValue = overrides.claim_token ?? null;
      executeSqliteQuerySync(
        db,
        kysely.insertInto("channel_ingress_events").values({
          queue_name: queueName,
          event_id: eventId,
          channel_id: "test",
          account_id: "account",
          status: overrides.status ?? "pending",
          lane_key: null,
          payload_json: overrides.payload_json ?? "null",
          metadata_json: overrides.metadata_json ?? null,
          completed_metadata_json: overrides.completed_metadata_json ?? null,
          received_at: 100,
          updated_at: 200,
          attempts: 0,
          claim_token: claimValue,
          claim_owner: overrides.claim_owner ?? null,
          claimed_at: overrides.claimed_at ?? null,
          completed_at: overrides.completed_at ?? null,
        } as any),
      );
    }

    it("skips a pending row with corrupt payload_json in listPending", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        await queue.enqueue("good-1", { text: "hello" });
        insertCorruptRow(stateDir, '["test","account"]', "bad-1", {
          payload_json: "{corrupt: true, >>>NOT JSON<<<",
        });
        await queue.enqueue("good-2", { text: "world" });

        const pending = await queue.listPending();
        expect(pending).toHaveLength(2);
        expect(pending.map((r) => r.id).toSorted()).toEqual(["good-1", "good-2"]);
      });
    });

    it("applies listPending limits after excluding corrupt payloads", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });
        for (let index = 0; index < 100; index += 1) {
          insertCorruptRow(
            stateDir,
            '["test","account"]',
            `bad-${index.toString().padStart(3, "0")}`,
            { payload_json: "{corrupt" },
          );
        }
        await queue.enqueue("good-second", { text: "visible" }, { receivedAt: 300 });

        const pending = await queue.listPending({ limit: 1 });

        expect(pending.map((record) => record.id)).toEqual(["good-second"]);
      });
    });

    it("uses the queue JSON contract when listing deeply nested payloads", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<unknown>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });
        const nestedJson = `${"[".repeat(1001)}0${"]".repeat(1001)}`;
        const payload = JSON.parse(nestedJson);

        await queue.enqueue("deep", payload);

        await expect(queue.listPending({ limit: 1 })).resolves.toMatchObject([{ id: "deep" }]);
      });
    });

    it("skips corrupt metadata_json in listPending", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }, { source: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        await queue.enqueue("ev-1", { text: "ok" }, { metadata: { source: "good" } });
        insertCorruptRow(stateDir, '["test","account"]', "ev-bad-meta", {
          payload_json: JSON.stringify({ text: "has corrupt metadata" }),
          metadata_json: "{broken",
        });

        const pending = await queue.listPending();
        const bad = pending.find((r) => r.id === "ev-bad-meta");
        expect(bad).not.toBeNull();
        expect(bad!.metadata).toBeUndefined();
      });
    });

    it("skips a claimed row with corrupt payload_json in listClaims", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        await queue.enqueue("claim-ok", { text: "ok" });
        insertCorruptRow(stateDir, '["test","account"]', "claim-bad", {
          payload_json: "{{{broken",
          status: "claimed",
          claim_token: "test-token-placeholder",
          claim_owner: "worker",
          claimed_at: 200,
        });

        // Verify that listClaims skips the corrupt claimed row.
        const initialClaims = await queue.listClaims();
        expect(initialClaims.some((c) => c.id === "claim-bad")).toBe(false);

        // The valid enqueued row can still be claimed.
        const claimResult = await queue.claim("claim-ok");
        expect(claimResult).not.toBeNull();

        const allClaims = await queue.listClaims();
        expect(allClaims.some((c) => c.id === "claim-bad")).toBe(false);
      });
    });

    it("skips corrupt completed_metadata_json during duplicate detection", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }, unknown, { handler: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        await queue.enqueue("comp-1", { text: "first" });
        await queue.complete("comp-1", { metadata: { handler: "worker" }, completedAt: 150 });

        // Corrupt the completed_metadata_json
        const { db } = openOpenClawStateDatabase({
          env: createStateDirEnv(stateDir),
        });
        db.prepare(
          `UPDATE channel_ingress_events
             SET completed_metadata_json = ?
           WHERE queue_name = ? AND event_id = ?`,
        ).run("not valid json", '["test","account"]', "comp-1");

        // Duplicate detection should still work (metadata just omitted)
        const dup = await queue.enqueue("comp-1", { text: "late" });
        expect(dup.kind).toBe("completed");
        if (dup.kind === "completed") {
          expect(dup.record.metadata).toBeUndefined();
        }
      });
    });

    it("claimNext skips a corrupt first pending row without lane derivation", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        // Insert the bad row first so it sorts before the good row.
        const earlyTime = 10;
        insertCorruptRow(stateDir, '["test","account"]', "bad-claim", {
          payload_json: "{corrupt",
        });
        // Override the bad row's received_at to be earlier.
        {
          const { db } = openOpenClawStateDatabase({
            env: createStateDirEnv(stateDir),
          });
          db.prepare(
            `UPDATE channel_ingress_events SET received_at = ? WHERE queue_name = ? AND event_id = ?`,
          ).run(earlyTime, '["test","account"]', "bad-claim");
        }
        await queue.enqueue("good-1", { text: "hello" }, { receivedAt: earlyTime + 10 });

        const claimed = await queue.claimNext();
        expect(claimed).not.toBeNull();
        expect(claimed!.id).toBe("good-1");

        const database = openOpenClawStateDatabase({ env: createStateDirEnv(stateDir) });
        const failed = executeSqliteQueryTakeFirstSync(
          database.db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(database.db)
            .selectFrom("channel_ingress_events")
            .select(["status", "failed_reason", "payload_json"])
            .where("queue_name", "=", '["test","account"]')
            .where("event_id", "=", "bad-claim"),
        );
        expect(failed).toEqual({
          status: "failed",
          failed_reason: "corrupt_payload",
          payload_json: "null",
        });
      });
    });

    it("makes durable progress when a corrupt prefix fills the claim scan limit", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });
        insertCorruptRow(stateDir, '["test","account"]', "bad-first", {
          payload_json: "{corrupt",
        });
        await queue.enqueue("good-second", { text: "claimable" }, { receivedAt: 300 });

        await expect(queue.claimNext({ scanLimit: 1 })).resolves.toMatchObject({
          id: "good-second",
          payload: { text: "claimable" },
        });
      });
    });

    it("bounds corrupt reconciliation work per claimNext call", async () => {
      await withTempState(async (stateDir) => {
        const queueName = '["test","account"]';
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });
        for (let index = 0; index < 101; index += 1) {
          insertCorruptRow(stateDir, queueName, `bad-${index.toString().padStart(3, "0")}`, {
            payload_json: "{corrupt",
          });
        }

        await expect(queue.claimNext({ scanLimit: 200 })).resolves.toBeNull();

        const database = openOpenClawStateDatabase({ env: createStateDirEnv(stateDir) });
        const counts = executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(database.db)
            .selectFrom("channel_ingress_events")
            .select(["status"])
            .where("queue_name", "=", queueName),
        ).rows;
        expect(counts.filter((row) => row.status === "failed")).toHaveLength(100);
        expect(counts.filter((row) => row.status === "pending")).toHaveLength(1);

        await expect(queue.claimNext({ scanLimit: 200 })).resolves.toBeNull();
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      });
    });

    it("claim returns null for a corrupt pending row", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        await queue.enqueue("good-1", { text: "hello" });
        insertCorruptRow(stateDir, '["test","account"]', "bad-direct", {
          payload_json: "{corrupt",
        });

        // The corrupt row should not be claimable.
        const badClaim = await queue.claim("bad-direct");
        expect(badClaim).toBeNull();

        // The good row should still be claimable.
        const goodClaim = await queue.claim("good-1");
        expect(goodClaim).not.toBeNull();
        expect(goodClaim!.payload.text).toBe("hello");

        const database = openOpenClawStateDatabase({ env: createStateDirEnv(stateDir) });
        const failed = executeSqliteQueryTakeFirstSync(
          database.db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(database.db)
            .selectFrom("channel_ingress_events")
            .select(["status", "failed_reason"])
            .where("queue_name", "=", '["test","account"]')
            .where("event_id", "=", "bad-direct"),
        );
        expect(failed).toEqual({ status: "failed", failed_reason: "corrupt_payload" });
      });
    });

    it("handles valid JSON null payload correctly", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<null>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        // Valid JSON null should parse as null, not be treated as corrupt.
        await queue.enqueue("null-ok", null);
        const pending = await queue.listPending();
        expect(pending).toHaveLength(1);
        expect(expectDefined(pending[0], "pending[0] test invariant").payload).toBeNull();
      });
    });

    it("tombstones a corrupt pending row on duplicate enqueue", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        insertCorruptRow(stateDir, '["test","account"]', "dup-bad", {
          payload_json: "{corrupt",
        });

        const result = await queue.enqueue("dup-bad", { text: "late" });
        expect(result.kind).toBe("failed");
        if (result.kind === "failed") {
          expect(result.duplicate).toBe(true);
          expect(result.record.reason).toBe("corrupt_payload");
        }

        // Verify the corrupt row was actually tombstoned in the DB.
        const { db } = openOpenClawStateDatabase({
          env: createStateDirEnv(stateDir),
        });
        const row = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
            .selectFrom("channel_ingress_events")
            .select(["status", "failed_reason", "payload_json", "claim_token", "claimed_at"])
            .where("queue_name", "=", '["test","account"]')
            .where("event_id", "=", "dup-bad"),
        ).rows[0];
        expect(row?.status).toBe("failed");
        expect(row?.failed_reason).toBe("corrupt_payload");
        expect(row?.payload_json).toBe("null");
        expect(row?.claim_token).toBeNull();
        expect(row?.claimed_at).toBeNull();
      });
    });

    it("does not tombstone a corrupt actively claimed row on duplicate enqueue", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });
        insertCorruptRow(stateDir, '["test","account"]', "dup-claimed-bad", {
          payload_json: "{corrupt",
          status: "claimed",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 200,
        });

        await expect(queue.enqueue("dup-claimed-bad", { text: "late" })).rejects.toThrow(
          "Corrupt payload_json in claimed channel ingress event",
        );

        const { db } = openOpenClawStateDatabase({
          env: createStateDirEnv(stateDir),
        });
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
            .selectFrom("channel_ingress_events")
            .select(["status", "payload_json", "claim_token", "claim_owner", "claimed_at"])
            .where("queue_name", "=", '["test","account"]')
            .where("event_id", "=", "dup-claimed-bad"),
        );
        expect(row).toEqual({
          status: "claimed",
          payload_json: "{corrupt",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 200,
        });
      });
    });

    it("tombstones corrupt claimed rows during stale recovery", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });

        const oldTime = 10;
        insertCorruptRow(stateDir, '["test","account"]', "stale-bad", {
          payload_json: "{corrupt",
          status: "claimed",
          claim_token: "test-token-placeholder",
          claim_owner: "worker",
          claimed_at: oldTime,
        });

        const recovered = await queue.recoverStaleClaims({
          staleMs: Date.now() - oldTime,
        });
        expect(recovered).toBe(1);

        // The corrupt claimed row should now be tombstoned as failed.
        const { db } = openOpenClawStateDatabase({
          env: createStateDirEnv(stateDir),
        });
        const row = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
            .selectFrom("channel_ingress_events")
            .select(["status", "failed_reason", "payload_json", "claim_token", "claimed_at"])
            .where("queue_name", "=", '["test","account"]')
            .where("event_id", "=", "stale-bad"),
        ).rows[0];
        expect(row?.status).toBe("failed");
        expect(row?.failed_reason).toBe("corrupt_payload");
        expect(row?.payload_json).toBe("null");
        expect(row?.claim_token).toBeNull();
        expect(row?.claimed_at).toBeNull();
        await expect(queue.recoverStaleClaims({ staleMs: Date.now() - oldTime })).resolves.toBe(0);
      });
    });

    it("does not bypass recovery policy for a corrupt stale claim", async () => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "test",
          accountId: "account",
          stateDir,
        });
        insertCorruptRow(stateDir, '["test","account"]', "stale-policy-bad", {
          payload_json: "{corrupt",
          status: "claimed",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 10,
        });
        const shouldRecover = vi.fn(() => true);
        const shouldRecoverCorrupt = vi.fn(() => false);

        await expect(
          queue.recoverStaleClaims({
            staleMs: 10,
            now: 20,
            shouldRecover,
            shouldRecoverCorrupt,
          }),
        ).resolves.toBe(0);
        expect(shouldRecover).not.toHaveBeenCalled();
        expect(shouldRecoverCorrupt).toHaveBeenCalledWith({
          id: "stale-policy-bad",
          channelId: "test",
          accountId: "account",
          queueName: '["test","account"]',
          reason: "corrupt_payload",
          claim: {
            token: "test-token-placeholder",
            ownerId: "active-worker",
            claimedAt: 10,
          },
        });

        const { db } = openOpenClawStateDatabase({
          env: createStateDirEnv(stateDir),
        });
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
            .selectFrom("channel_ingress_events")
            .select(["status", "payload_json", "claim_token", "claim_owner", "claimed_at"])
            .where("queue_name", "=", '["test","account"]')
            .where("event_id", "=", "stale-policy-bad"),
        );
        expect(row).toEqual({
          status: "claimed",
          payload_json: "{corrupt",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 10,
        });

        await expect(
          queue.recoverStaleClaims({
            staleMs: 10,
            now: 20,
            shouldRecover,
            shouldRecoverCorrupt: () => true,
          }),
        ).resolves.toBe(1);
        const failed = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
            .selectFrom("channel_ingress_events")
            .select(["status", "failed_reason"])
            .where("queue_name", "=", '["test","account"]')
            .where("event_id", "=", "stale-policy-bad"),
        );
        expect(failed).toEqual({ status: "failed", failed_reason: "corrupt_payload" });
      });
    });
  });
});
