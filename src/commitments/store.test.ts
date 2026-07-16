// Covers canonical commitment persistence, queries, and concurrent mutations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  listCommitments,
  listDueCommitmentSessionKeys,
  listDueCommitmentsForSession,
  listPendingCommitmentsForScope,
  markCommitmentsAttempted,
  markCommitmentsStatus,
  upsertInferredCommitments,
} from "./store.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "./store.test-utils.js";
import type { CommitmentCandidate, CommitmentRecord } from "./types.js";

describe("commitment SQLite store", () => {
  const tmpDirs: string[] = [];
  let stateDirEnvSnapshot: ReturnType<typeof captureEnv> | undefined;
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
  const sessionKey = "agent:main:telegram:user-155462274";

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    stateDirEnvSnapshot?.restore();
    stateDirEnvSnapshot = undefined;
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function useTempStateDir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitments-store-"));
    tmpDirs.push(tmpDir);
    stateDirEnvSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
    return tmpDir;
  }

  function commitment(overrides?: Partial<CommitmentRecord>): CommitmentRecord {
    return {
      id: "cm_interview",
      agentId: "main",
      sessionKey,
      channel: "telegram",
      to: "155462274",
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      status: "pending",
      reason: "The user said they had an interview yesterday.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-28",
      confidence: 0.92,
      dueWindow: {
        earliestMs: nowMs - 60_000,
        latestMs: nowMs + 60 * 60_000,
        timezone: "America/Los_Angeles",
      },
      createdAtMs: nowMs - 24 * 60 * 60_000,
      updatedAtMs: nowMs - 24 * 60 * 60_000,
      attempts: 0,
      ...overrides,
    };
  }

  it("does not surface due commitments unless inferred commitments are enabled", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([commitment()]);

    await expect(
      listDueCommitmentsForSession({ cfg: {}, agentId: "main", sessionKey, nowMs }),
    ).resolves.toStrictEqual([]);
  });

  it("limits delivered commitments per agent session in a rolling day", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([
      commitment({ id: "cm_sent", status: "sent", sentAtMs: nowMs - 60_000 }),
      commitment({ id: "cm_pending", dedupeKey: "interview:followup" }),
    ]);

    await expect(
      listDueCommitmentsForSession({
        cfg: { commitments: { enabled: true, maxPerDay: 1 } },
        agentId: "main",
        sessionKey,
        nowMs,
      }),
    ).resolves.toStrictEqual([]);
    expect(readCommitmentsForTest()).toHaveLength(2);
  });

  it("preserves due windows, snoozes, caps, agent scope, and key ordering", async () => {
    await useTempStateDir();
    const sessionA = "agent:main:telegram:user-a";
    const sessionB = "agent:main:telegram:user-b";
    const sessionC = "agent:main:telegram:user-c";
    seedCommitmentsForTest([
      commitment({ id: "cm_b_sent_1", sessionKey: sessionB, status: "sent", sentAtMs: nowMs }),
      commitment({
        id: "cm_b_sent_2",
        sessionKey: sessionB,
        status: "sent",
        sentAtMs: nowMs - 60_000,
      }),
      commitment({ id: "cm_b_due", sessionKey: sessionB }),
      commitment({ id: "cm_c_due", sessionKey: sessionC }),
      commitment({ id: "cm_a_due", sessionKey: sessionA }),
      commitment({
        id: "cm_old_sent",
        sessionKey: sessionA,
        status: "sent",
        sentAtMs: nowMs - 25 * 60 * 60_000,
      }),
      commitment({
        id: "cm_c_snoozed",
        sessionKey: sessionC,
        status: "snoozed",
        snoozedUntilMs: nowMs + 60_000,
      }),
      commitment({
        id: "cm_c_future",
        sessionKey: sessionC,
        dueWindow: {
          earliestMs: nowMs + 60_000,
          latestMs: nowMs + 120_000,
          timezone: "America/Los_Angeles",
        },
      }),
      commitment({ id: "cm_other_agent", agentId: "work", sessionKey: sessionA }),
    ]);

    await expect(
      listDueCommitmentSessionKeys({
        cfg: { commitments: { enabled: true, maxPerDay: 2 } },
        agentId: "main",
        nowMs,
      }),
    ).resolves.toStrictEqual([sessionA, sessionC]);
  });

  it("discovers one concentrated due session through indexed SQLite queries", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([
      commitment({ id: "cm_sent", status: "sent", sentAtMs: nowMs - 60_000 }),
      ...Array.from({ length: 8_000 }, (_, index) =>
        commitment({ id: `cm_due_${index}`, dedupeKey: `interview:followup:${index}` }),
      ),
    ]);

    await expect(
      listDueCommitmentSessionKeys({
        cfg: { commitments: { enabled: true } },
        agentId: "main",
        nowMs,
        limit: 10,
      }),
    ).resolves.toStrictEqual([sessionKey]);
  });

  it("expires stale pending commitments atomically", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([
      commitment({
        dueWindow: {
          earliestMs: nowMs - 5 * 24 * 60 * 60_000,
          latestMs: nowMs - 4 * 24 * 60 * 60_000,
          timezone: "America/Los_Angeles",
        },
      }),
    ]);

    await expect(
      listDueCommitmentsForSession({
        cfg: { commitments: { enabled: true } },
        agentId: "main",
        sessionKey,
        nowMs,
      }),
    ).resolves.toStrictEqual([]);
    expect(readCommitmentsForTest()[0]).toMatchObject({
      id: "cm_interview",
      status: "expired",
      expiredAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  });

  it("matches the complete route scope", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([
      commitment({ accountId: "primary", threadId: "topic", senderId: "sender" }),
    ]);
    await expect(
      listPendingCommitmentsForScope({
        scope: {
          agentId: "main",
          sessionKey,
          channel: "telegram",
          accountId: "primary",
          to: "155462274",
          threadId: "topic",
          senderId: "sender",
        },
        nowMs,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      listPendingCommitmentsForScope({
        scope: {
          agentId: "main",
          sessionKey,
          channel: "telegram",
          accountId: "other",
          to: "155462274",
          threadId: "topic",
          senderId: "sender",
        },
        nowMs,
      }),
    ).resolves.toStrictEqual([]);
  });

  it("lists expired commitments after expiry transition", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([
      commitment({
        dueWindow: {
          earliestMs: nowMs - 5 * 24 * 60 * 60_000,
          latestMs: nowMs - 4 * 24 * 60 * 60_000,
          timezone: "America/Los_Angeles",
        },
      }),
    ]);
    await listDueCommitmentsForSession({
      cfg: { commitments: { enabled: true } },
      agentId: "main",
      sessionKey,
      nowMs,
    });
    await expect(listCommitments({ status: "expired", nowMs })).resolves.toMatchObject([
      { id: "cm_interview", status: "expired" },
    ]);
  });

  it("preserves concurrent status writes to disjoint ids", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([
      commitment({ id: "cm_raceA", dedupeKey: "race-A" }),
      commitment({ id: "cm_raceB", dedupeKey: "race-B" }),
    ]);
    await Promise.all([
      markCommitmentsStatus({ ids: ["cm_raceA"], status: "dismissed", nowMs }),
      markCommitmentsStatus({ ids: ["cm_raceB"], status: "dismissed", nowMs }),
    ]);
    const byId = Object.fromEntries(readCommitmentsForTest().map((record) => [record.id, record]));
    expect(byId.cm_raceA?.status).toBe("dismissed");
    expect(byId.cm_raceB?.status).toBe("dismissed");
  });

  it("increments concurrent attempt bumps without losing a write", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([commitment({ id: "cm_race_attempts", attempts: 0 })]);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        markCommitmentsAttempted({ ids: ["cm_race_attempts"], nowMs }),
      ),
    );
    expect(readCommitmentsForTest()[0]?.attempts).toBe(5);
  });

  it("serializes a terminal transition against an unrelated attempt bump", async () => {
    await useTempStateDir();
    seedCommitmentsForTest([
      commitment({ id: "cm_dismiss_target", dedupeKey: "dismiss-target" }),
      commitment({ id: "cm_attempt_target", dedupeKey: "attempt-target", attempts: 2 }),
    ]);
    await Promise.all([
      markCommitmentsStatus({ ids: ["cm_dismiss_target"], status: "dismissed", nowMs }),
      markCommitmentsAttempted({ ids: ["cm_attempt_target"], nowMs }),
    ]);
    const byId = Object.fromEntries(readCommitmentsForTest().map((record) => [record.id, record]));
    expect(byId.cm_dismiss_target?.status).toBe("dismissed");
    expect(byId.cm_attempt_target?.attempts).toBe(3);
  });

  it("deduplicates concurrent same-scope inference inside SQLite transactions", async () => {
    await useTempStateDir();
    const candidate: CommitmentCandidate = {
      itemId: "item",
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      reason: "Interview",
      suggestedText: "How did it go?",
      dedupeKey: "interview:2026-04-28",
      confidence: 0.9,
      dueWindow: { earliest: new Date(nowMs).toISOString() },
    };
    const params = {
      item: {
        agentId: "main",
        sessionKey,
        channel: "telegram",
        to: "155462274",
        itemId: "item",
        nowMs,
        timezone: "UTC",
        userText: "Interview tomorrow",
        existingPending: [],
      },
      candidates: [{ candidate, earliestMs: nowMs, latestMs: nowMs + 60_000, timezone: "UTC" }],
      nowMs,
    };
    await Promise.all([upsertInferredCommitments(params), upsertInferredCommitments(params)]);
    expect(readCommitmentsForTest()).toHaveLength(1);
  });

  it("rejects malformed candidates before they can poison canonical rows", async () => {
    await useTempStateDir();
    const candidate: CommitmentCandidate = {
      itemId: "item",
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      reason: "   ",
      suggestedText: "How did it go?",
      dedupeKey: "interview:invalid",
      confidence: 0.9,
      dueWindow: { earliest: new Date(nowMs).toISOString() },
    };
    const created = await upsertInferredCommitments({
      item: {
        agentId: "main",
        sessionKey,
        channel: "telegram",
        to: "155462274",
        itemId: "item",
        nowMs,
        timezone: "UTC",
        userText: "Interview tomorrow",
        existingPending: [],
      },
      candidates: [{ candidate, earliestMs: nowMs, latestMs: nowMs + 60_000, timezone: "UTC" }],
      nowMs,
    });

    expect(created).toStrictEqual([]);
    await expect(listCommitments({ nowMs })).resolves.toStrictEqual([]);
  });

  it("never creates the retired commitments JSON directory", async () => {
    const stateDir = await useTempStateDir();
    seedCommitmentsForTest([commitment()]);
    await listDueCommitmentsForSession({
      cfg: { commitments: { enabled: true } },
      agentId: "main",
      sessionKey,
      nowMs,
    });
    await expect(fs.stat(path.join(stateDir, "commitments"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
