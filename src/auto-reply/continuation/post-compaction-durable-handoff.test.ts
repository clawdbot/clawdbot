import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeStagedPostCompactionDelegates,
  finalizeStagedPostCompactionDelegates,
  listRecoverableStagedPostCompactionDelegates,
  stagePostCompactionDelegate,
  stagedPostCompactionDelegateCount,
} from "../continuation/delegate-store-post-compaction.js";
import { cancelPendingDelegates } from "../continuation/delegate-store.js";

// Staged post-compaction delegates must
// stay non-terminal until the durable handoff (session-delivery enqueue /
// session-store persist) succeeds. consumeStagedPostCompactionDelegates claims
// the TaskFlow row to `running`; finalizeStagedPostCompactionDelegates finishes
// it only after the handoff, and listRecoverableStagedPostCompactionDelegates
// surfaces crash-orphaned `running` rows for startup re-dispatch (without
// terminalizing or requeuing them — see recoverAndReleaseStagedPostCompactionDelegates).

const sessionKey = "post-compaction-durable-handoff-test";

describe("post-compaction durable handoff", () => {
  beforeEach(() => {
    cancelPendingDelegates(sessionKey);
  });
  afterEach(() => {
    cancelPendingDelegates(sessionKey);
    vi.useRealTimers();
  });

  function stage(task: string): void {
    stagePostCompactionDelegate(sessionKey, {
      task,
      createdAt: 1_700_000_000_000,
      silent: true,
      silentWake: true,
    });
  }

  it("consume claims the row without terminalizing it (recoverable on crash before handoff)", () => {
    stage("evacuate context");
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(1);

    // Release (claim -> running). The row leaves the queued lane but is NOT
    // finished — the caller has not yet handed it off durably.
    const released = consumeStagedPostCompactionDelegates(sessionKey);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ task: "evacuate context" });
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);

    // Simulate a crash between release and durable handoff: finalize never runs.
    // Startup recovery must surface the claimed `running` row for re-dispatch
    // (it stays `running` — never terminalized, never requeued behind an
    // awaiting-seam row) so it can be handed off without a new compaction.
    const recoverable = listRecoverableStagedPostCompactionDelegates();
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.sessionKey).toBe(sessionKey);
    expect(recoverable[0]?.delegate).toMatchObject({ task: "evacuate context" });
    expect(recoverable[0]?.delegate.flowId).toBeDefined();
    // The row stays `running` (not flipped back to a queued awaiting-seam row).
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);
  });

  it("finalize after handoff terminalizes the row so recovery cannot replay it", () => {
    stage("evacuate context");
    const released = consumeStagedPostCompactionDelegates(sessionKey);
    expect(released).toHaveLength(1);

    // Durable handoff succeeded: finalize exactly the claimed row.
    const finalized = finalizeStagedPostCompactionDelegates(released.map((d) => d.flowId));
    expect(finalized).toBe(1);

    // No running rows remain, so recovery surfaces nothing to re-dispatch.
    expect(listRecoverableStagedPostCompactionDelegates()).toHaveLength(0);
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);
    expect(consumeStagedPostCompactionDelegates(sessionKey)).toHaveLength(0);
  });

  it("finalizes only the rows this caller claimed, leaving others recoverable", () => {
    stage("first");
    const firstRelease = consumeStagedPostCompactionDelegates(sessionKey);
    expect(firstRelease).toHaveLength(1);

    // A second delegate is staged and claimed by an independent/other consume;
    // its row must survive the first caller's finalize (a crash-orphaned or
    // concurrently-claimed row must never be terminalized out from under it).
    stage("second");
    const secondRelease = consumeStagedPostCompactionDelegates(sessionKey);
    expect(secondRelease).toHaveLength(1);

    // Finalizing only the first caller's flow ids finishes only the first row.
    const finalized = finalizeStagedPostCompactionDelegates(firstRelease.map((d) => d.flowId));
    expect(finalized).toBe(1);

    // The second (independently-claimed) row is untouched and still recoverable:
    // startup recovery surfaces only the `running` "second" row for re-dispatch.
    const recoverable = listRecoverableStagedPostCompactionDelegates();
    expect(recoverable.map((r) => r.delegate.task)).toContain("second");
    expect(recoverable.map((r) => r.delegate.task)).not.toContain("first");
  });

  it("re-staging before finalize preserves a delegate when the durable persist fails", () => {
    // Models the persist-failure path (agent-runner / dispatch): after claiming
    // the row to `running`, a fresh queued row is re-staged BEFORE the claimed
    // row is finalized, so a crash cannot drop the delegate behind a premature
    // `finished` row (autoreview follow-up).
    stage("evacuate context");
    const released = consumeStagedPostCompactionDelegates(sessionKey);
    expect(released).toHaveLength(1);
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);

    // Re-stage a fresh queued row (durable) BEFORE finalizing the claimed row.
    stagePostCompactionDelegate(
      sessionKey,
      expectDefined(released.at(0), "released post-compaction delegate"),
    );
    const finalized = finalizeStagedPostCompactionDelegates(released.map((d) => d.flowId));
    expect(finalized).toBe(1);

    // The re-staged queued row survives; the old claimed row is terminal, so
    // recovery finds no running row to re-dispatch and the delegate is not duplicated.
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(1);
    expect(listRecoverableStagedPostCompactionDelegates()).toHaveLength(0);
    const rereleased = consumeStagedPostCompactionDelegates(sessionKey);
    expect(rereleased.map((d) => d.task)).toContain("evacuate context");
  });

  it("preserves managed artifact return metadata when staging a session delegate", () => {
    stagePostCompactionDelegate(sessionKey, {
      task: "produce a managed report",
      createdAt: 1_700_000_000_000,
      returnOptions: { artifacts: "required" },
      recipientContext: { purpose: "Use the report after compaction." },
    });

    expect(consumeStagedPostCompactionDelegates(sessionKey)).toEqual([
      expect.objectContaining({
        task: "produce a managed report",
        returnOptions: { artifacts: "required" },
        recipientContext: { purpose: "Use the report after compaction." },
      }),
    ]);
  });

  it("startup recovery boot cutoff skips rows claimed by live traffic after process start", () => {
    // A row claimed to `running` AFTER the boot cutoff is a live release, not a
    // crash-orphaned row. Startup recovery must not surface it for re-dispatch
    // (which would race the live finalizer and release the delegate twice).
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_100_000);
    stage("evacuate context");
    const bootCutoff = Date.now();
    // Live release claims the row well after the boot cutoff.
    vi.setSystemTime(1_700_000_200_000);
    const released = consumeStagedPostCompactionDelegates(sessionKey);
    expect(released).toHaveLength(1);
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);

    // Bounded recovery excludes the live row (updatedAt after the cutoff).
    expect(
      listRecoverableStagedPostCompactionDelegates({ runningUpdatedAtOrBefore: bootCutoff }),
    ).toHaveLength(0);

    // A crash-orphaned row (updated at/before the cutoff) is still surfaced when
    // recovery runs without a cutoff; the row stays `running` until re-dispatched.
    const recoverable = listRecoverableStagedPostCompactionDelegates();
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.delegate).toMatchObject({ task: "evacuate context" });
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);
  });
});
