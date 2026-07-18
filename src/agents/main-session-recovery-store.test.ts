import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
} from "../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
  inspectMainSessionRecoveryRequired,
  readMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "./main-session-recovery-store.js";

const sessionKey = "agent:main:main";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("main session recovery store", () => {
  let dir: string;
  let lifecycleGeneration: string;
  let storePath: string;

  beforeEach(() => {
    dir = tempDirs.make("openclaw-main-recovery-store-");
    lifecycleGeneration = getAgentEventLifecycleGeneration();
    storePath = path.join(dir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function write(entry: SessionEntry): Promise<void> {
    await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
  }

  function read(): SessionEntry {
    return sessionAccessor.loadSessionEntry({ sessionKey, storePath })!;
  }

  function readStore(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntries({ storePath }).map(({ sessionKey: key, entry }) => [key, entry]),
    );
  }

  async function seedExact(entries: Record<string, SessionEntry>): Promise<void> {
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: Object.entries(entries).map(([key, entry]) => ({ sessionKey: key, entry })),
      skipMaintenance: true,
    });
  }

  function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 0,
      },
      ...overrides,
    };
  }

  async function reserve(targetSessionKey = sessionKey) {
    const result = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration,
        now: 200,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-1",
      },
      target: { sessionKey: targetSessionKey, storePath },
    });
    if (result.transition.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    return result.transition.reservation;
  }

  it("persists a cycle before returning a legacy interrupted observation", async () => {
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });

    const result = await commitMainSessionRecovery({
      command: {
        kind: "observe",
        cycleId: "cycle-1",
        lifecycleGeneration,
        sessionKey,
      },
      requireWriteSuccess: true,
      target: { sessionKey, storePath },
    });

    expect(result.transition).toMatchObject({
      kind: "observed",
      view: { status: "recoverable" },
    });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-1",
      revision: 1,
    });
  });

  it("preserves a concurrent foreground claim while cancelling its reservation", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();
    await commitMainSessionRecovery({
      command: {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration,
        sessionId: "session-1",
        sessionKey,
        claimId: "foreground-1",
      },
      target: { sessionKey, storePath },
    });

    await commitMainSessionRecovery({
      command: { kind: "cancel_reservation", reservation },
      target: { sessionKey, storePath },
    });

    expect(read().mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      foregroundClaims: {
        lifecycleGeneration,
        tokens: ["foreground-1"],
      },
    });
  });

  it("cancels a reservation after Gateway migrates its legacy session key", async () => {
    const legacyKey = "main";
    await seedExact({ [legacyKey]: interruptedEntry() });
    const reservation = await reserve(legacyKey);
    const legacyEntry = readStore()[legacyKey]!;
    await applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ sessionKey: legacyKey }],
      upserts: [{ sessionKey, entry: legacyEntry }],
      skipMaintenance: true,
    });

    const cancelled = await commitMainSessionRecovery({
      command: { kind: "cancel_reservation", reservation },
      target: { sessionKey: legacyKey, storePath },
    });

    expect(cancelled.transition).toEqual({ kind: "applied" });
    expect(read().mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(read().mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("abandons a reservation after Gateway migrates its legacy session key", async () => {
    const legacyKey = "main";
    await seedExact({ [legacyKey]: interruptedEntry() });
    const reservation = await reserve(legacyKey);
    const legacyEntry = readStore()[legacyKey]!;
    await applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ sessionKey: legacyKey }],
      upserts: [{ sessionKey, entry: legacyEntry }],
      skipMaintenance: true,
    });

    const abandoned = await commitMainSessionRecovery({
      command: { kind: "abandon_reservation", reservation },
      target: { sessionKey: legacyKey, storePath },
    });

    expect(abandoned.transition).toEqual({ kind: "applied" });
    expect(read().mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
    expect(read().mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("admits a legacy-key reservation through its canonical Gateway key", async () => {
    const legacyKey = "main";
    await seedExact({ [legacyKey]: interruptedEntry() });
    await reserve(legacyKey);

    const validated = await commitMainSessionRecovery({
      command: {
        kind: "validate_recovery",
        lifecycleGeneration,
        runId: "recovery-1",
        sessionId: "session-1",
      },
      target: { sessionKey, storePath },
    });
    expect(validated.transition).toEqual({ kind: "recovery_validated" });

    const admitted = await commitMainSessionRecovery({
      command: {
        kind: "admit_recovery",
        lifecycleGeneration,
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      },
      target: { sessionKey, storePath },
    });
    expect(admitted.transition).toEqual({ kind: "admitted_recovery" });
    expect(readStore()[legacyKey]).toMatchObject({
      abortedLastRun: false,
      mainRestartRecovery: { chargedAttempts: 1 },
    });
    expect(readStore()[legacyKey]?.mainRestartRecovery?.reservation).toBeUndefined();

    const restored = await commitMainSessionRecovery({
      command: {
        kind: "mark_admitted_recovery_interrupted",
        lifecycleGeneration,
        now: 400,
        runId: "recovery-1",
        sessionId: "session-1",
      },
      target: { sessionKey: admitted.sessionKey!, storePath },
    });
    expect(restored.transition).toEqual({ kind: "applied" });
    expect(readStore()[legacyKey]).toMatchObject({ abortedLastRun: true });
  });

  it("rejects an observation after the session is replaced", async () => {
    await write({
      sessionId: "session-2",
      updatedAt: 300,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 1,
        chargedAttempts: 0,
      },
    });

    const result = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration,
        now: 400,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "stale-recovery",
      },
      target: { sessionKey, storePath },
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "session_replaced" });
    expect(read().mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("does not cancel a reservation after its session is replaced", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();

    await write({
      sessionId: "session-2",
      updatedAt: 300,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 4,
        chargedAttempts: 2,
      },
    });

    const cancelled = await commitMainSessionRecovery({
      command: { kind: "cancel_reservation", reservation },
      target: { sessionKey, storePath },
    });

    expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(read()).toMatchObject({
      sessionId: "session-2",
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 4,
        chargedAttempts: 2,
      },
    });
  });

  it("does not let an old reservation survive healthy clear and immediate re-wedge", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();
    await commitMainSessionRecovery({
      command: { kind: "clear" },
      target: { sessionKey, storePath },
    });
    await commitMainSessionRecovery({
      command: { kind: "mark_interrupted", cycleId: "cycle-2", now: 300 },
      target: { sessionKey, storePath },
    });

    const cancelled = await commitMainSessionRecovery({
      command: { kind: "cancel_reservation", reservation },
      target: { sessionKey, storePath },
    });

    expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      chargedAttempts: 0,
    });
  });

  it("claims an interrupted row through its pre-migration alias", async () => {
    const legacyKey = "main";
    await seedExact({ [legacyKey]: interruptedEntry() });

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });

    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") {
      return;
    }
    expect(claim.lease.sessionKey).toBe(legacyKey);
    expect(readStore()[legacyKey]).toMatchObject({
      mainRestartRecovery: {
        foregroundClaims: {
          lifecycleGeneration,
          tokens: [claim.lease.claimId],
        },
      },
    });
  });

  it("claims the exact foreground row without scanning aliases", async () => {
    await write(interruptedEntry());
    const accessorSpy = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });

    expect(claim.kind).toBe("claimed");
    expect(accessorSpy).toHaveBeenCalledOnce();
    expect(accessorSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKeys: [sessionKey] });
  });

  it("binds a foreground claim to its lifecycle run", async () => {
    await write(interruptedEntry());

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      runId: "foreground-run",
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });

    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    expect(read()).toMatchObject({
      restartRecoveryRuns: [{ lifecycleGeneration, runId: "foreground-run" }],
      mainRestartRecovery: {
        foregroundClaims: {
          lifecycleGeneration,
          runIdsByClaimId: { [claim.lease.claimId]: "foreground-run" },
        },
      },
    });
  });

  it("releases an owner after the durable row session id rotates", async () => {
    await write(interruptedEntry());
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const current = read();
    await write({ ...current, sessionId: "session-2" });

    await expect(releaseMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();

    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("keeps retrying an exact owner release after immediate store retries fail", async () => {
    vi.useFakeTimers();
    try {
      await write(interruptedEntry());
      const claim = await claimMainSessionRecoveryOwner({
        lifecycleGeneration,
        sessionId: "session-1",
        target: { sessionKey, storePath },
      });
      if (claim.kind !== "claimed") {
        throw new Error("expected foreground owner claim");
      }
      const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
      let failures = 0;
      vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation(
        async (params) => {
          if (failures < 3) {
            failures += 1;
            throw new Error("transient session-store failure");
          }
          return await applySessionEntryReplacements(params);
        },
      );

      const immediateRelease = releaseMainSessionRecoveryOwner(claim.lease);
      const immediateReleaseRejected = expect(immediateRelease).rejects.toThrow(
        "transient session-store failure",
      );
      await vi.advanceTimersByTimeAsync(100);
      await immediateReleaseRejected;
      expect(read().mainRestartRecovery?.foregroundClaims?.tokens).toEqual([claim.lease.claimId]);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves interrupted non-main rows to their specialized recovery owner", async () => {
    const subagentKey = "agent:main:subagent:child";
    await seedExact({ [subagentKey]: interruptedEntry({ spawnDepth: 1 }) });

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey: subagentKey, storePath },
    });

    expect(claim).toEqual({ kind: "not_required" });
    expect(readStore()[subagentKey]?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("does not let a replacement bypass a tombstoned predecessor", async () => {
    await write(
      interruptedEntry({
        status: "failed",
        abortedLastRun: false,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    );

    await expect(
      claimMainSessionRecoveryOwner({
        lifecycleGeneration,
        replacementSessionId: "session-2",
        sessionId: "session-1",
        target: { sessionKey, storePath },
      }),
    ).resolves.toEqual({ kind: "invalidated", reason: "state_changed" });
  });

  it("does not let foreground work bypass an exhausted predecessor", async () => {
    await write(
      interruptedEntry({
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
        },
      }),
    );

    await expect(
      claimMainSessionRecoveryOwner({
        lifecycleGeneration,
        sessionId: "session-1",
        target: { sessionKey, storePath },
      }),
    ).resolves.toEqual({ kind: "invalidated", reason: "recovery_exhausted" });
    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("claims an interrupted legacy predecessor after its canonical key is reused", async () => {
    const legacyKey = "main";
    await seedExact({
      [sessionKey]: { sessionId: "session-2", updatedAt: 200 },
      [legacyKey]: interruptedEntry(),
    });

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      replacementSessionId: "session-2",
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });

    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    expect(claim.lease.sessionKey).toBe(legacyKey);
    expect(readStore()[legacyKey]?.mainRestartRecovery?.foregroundClaims?.tokens).toEqual([
      claim.lease.claimId,
    ]);
    expect(readStore()[sessionKey]?.mainRestartRecovery).toBeUndefined();
  });

  it("validates a transferred owner against the latest durable row", async () => {
    await write(interruptedEntry());
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }

    await expect(readMainSessionRecoveryOwner(claim.lease)).resolves.toBeDefined();
    await releaseMainSessionRecoveryOwner(claim.lease);
    await expect(readMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
  });

  it("returns a retry target only when the final foreground owner releases", async () => {
    await write(interruptedEntry());
    const first = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    const second = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    if (first.kind !== "claimed" || second.kind !== "claimed") {
      throw new Error("expected foreground owner claims");
    }

    await expect(releaseMainSessionRecoveryOwner(first.lease)).resolves.toBeUndefined();
    await expect(releaseMainSessionRecoveryOwner(second.lease)).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
    await expect(releaseMainSessionRecoveryOwner(second.lease)).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
  });

  it("does not let an old lease release a same-token claim from a new cycle", async () => {
    await write(interruptedEntry());
    const oldClaim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    if (oldClaim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    await commitMainSessionRecovery({
      command: { kind: "clear" },
      target: { sessionKey, storePath },
    });
    await commitMainSessionRecovery({
      command: { kind: "mark_interrupted", cycleId: "cycle-2", now: 300 },
      target: { sessionKey, storePath },
    });
    await commitMainSessionRecovery({
      command: {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration,
        sessionId: "session-1",
        sessionKey,
        claimId: oldClaim.lease.claimId,
      },
      target: { sessionKey, storePath },
    });

    await releaseMainSessionRecoveryOwner(oldClaim.lease);

    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      foregroundClaims: {
        lifecycleGeneration,
        tokens: [oldClaim.lease.claimId],
      },
    });
  });

  it("retries a transient owner release write failure", async () => {
    await write(interruptedEntry());
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const accessorSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockRejectedValueOnce(new Error("transient writer failure"))
      .mockImplementation(async (params) => await applySessionEntryReplacements(params));

    await releaseMainSessionRecoveryOwner(claim.lease);

    expect(accessorSpy).toHaveBeenCalledTimes(2);
    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("rejects an old claimant queued ahead of the current lifecycle generation", async () => {
    await write(interruptedEntry());

    let enterWriter = () => {};
    const writerEntered = new Promise<void>((resolve) => {
      enterWriter = resolve;
    });
    let releaseWriter = () => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const blocker = sessionAccessor.applySessionEntryReplacements({
      storePath,
      update: async () => {
        enterWriter();
        await writerGate;
        return { result: undefined };
      },
    });
    await writerEntered;

    const staleClaim = commitMainSessionRecovery({
      command: {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration,
        sessionId: "session-1",
        sessionKey,
        claimId: "stale-owner",
      },
      target: { sessionKey, storePath },
    });
    const staleOwnerClaim = claimMainSessionRecoveryOwner({
      allowMissingSession: true,
      lifecycleGeneration,
      replacementSessionId: "session-2",
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    const staleInspection = inspectMainSessionRecoveryRequired({
      expectedSessionId: "session-1",
      lifecycleGeneration,
      target: { sessionKey, storePath },
    });
    await Promise.resolve();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    const currentClaim = commitMainSessionRecovery({
      command: {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration: currentGeneration,
        sessionId: "session-1",
        sessionKey,
        claimId: "current-owner",
      },
      target: { sessionKey, storePath },
    });
    releaseWriter();

    await blocker;
    expect((await staleClaim).transition).toEqual({
      kind: "rejected",
      reason: "stale_generation",
    });
    await expect(staleOwnerClaim).resolves.toEqual({
      kind: "invalidated",
      reason: "stale_generation",
    });
    await expect(staleInspection).resolves.toEqual({
      kind: "invalidated",
      reason: "stale_generation",
    });
    expect((await currentClaim).transition).toMatchObject({
      kind: "foreground_claimed",
      claim: { claimId: "current-owner" },
    });
    expect(read().mainRestartRecovery?.foregroundClaims).toEqual({
      lifecycleGeneration: currentGeneration,
      tokens: ["current-owner"],
    });
  });

  it("rejects a delayed admitted-interruption callback after lifecycle rotation", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration }],
      }),
    );
    rotateAgentEventLifecycleGeneration();

    const result = await commitMainSessionRecovery({
      command: {
        kind: "mark_admitted_recovery_interrupted",
        lifecycleGeneration,
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      },
      target: { sessionKey, storePath },
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "stale_generation" });
    expect(read()).toMatchObject({
      sessionId: "session-1",
      status: "running",
      abortedLastRun: false,
    });
  });

  it("rejects a transferred foreground lease after lifecycle rotation", async () => {
    await write(interruptedEntry());
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
    });
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    rotateAgentEventLifecycleGeneration();

    await expect(readMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
  });
});
