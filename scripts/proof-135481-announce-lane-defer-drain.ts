/**
 * Real-behavior proof for the parked-announce lane-release drain (PR #135481).
 *
 * The claim under test is a timing claim, so the proof measures time: after the
 * requester's session lane frees, how long until the completion announce
 * actually starts? The review found the release wake still obeyed the parked
 * 60 s backstop deadline, so the answer was "up to 60 s" — the exact wait the
 * park exists to remove.
 *
 * What is REAL here (no vitest, no mocks of the seam under test):
 *   - `resumeSubagentRun()` — the production registry resumer that owns the
 *     `delivery.nextAttemptAt` not-before gate. Not a spy: the real one.
 *   - The real subagent registry singleton, loaded through the real durable
 *     restore path (`persistSubagentRunsToDiskOrThrow` into real SQLite, then
 *     `initSubagentRegistry()`), against a real session store in a temp
 *     OPENCLAW_HOME.
 *   - `parkAnnounceForRequesterLane()` — the production park, arming the real
 *     lane subscription.
 *   - The real command queue and the real `session:<key>` lane: the requester's
 *     turn is a real in-flight lane task, and the release is that task actually
 *     completing.
 *   - Persistence is the real SQLite writer, so the cleared deadline is
 *     re-read from disk rather than trusted in memory.
 *
 * Stubbed at the edge only: `runSubagentAnnounceFlow`, the outbound announce
 * sink. Everything between the lane release and that call is production code.
 * The sink records the wall-clock instant it was entered — that timestamp is
 * the measurement.
 *
 * Scenarios:
 *   1. PRE-FIX CONTROL — the real resumer, handed a row whose backstop deadline
 *      is still set: no announce. This is what the release wake did before.
 *   2. The real resumer, handed the same row with the deadline retired: the
 *      announce starts.
 *   3. END TO END — real busy lane, real park, real release. Measures the
 *      release-to-announce latency and re-reads the durable row.
 *   4. The backstop timestamp is still armed at park time, so the timer path
 *      that covers a lost listener is intact.
 *
 * Run: pnpm tsx scripts/proof-135481-announce-lane-defer-drain.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type SubagentRunRecord =
  import("../src/agents/subagents/registry/subagent-registry.types.js").SubagentRunRecord;
type LifecycleContext =
  import("../src/agents/subagents/registry/subagent-registry-lifecycle-context.js").SubagentLifecycleAnnounceCleanupContext;

const RELEASE_LATENCY_BUDGET_MS = 2_000;

let failures = 0;

function check(label: string, run: () => void): void {
  try {
    run();
    console.log(`   ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`   ✗ ${label}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  process.env.OPENCLAW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-135481-"));

  const paths = await import("../src/config/sessions/paths.js");
  const sessions = await import("../src/config/sessions/session-accessor.js");
  const registryState = await import("../src/agents/subagents/registry/subagent-registry-state.js");
  const registryDeps = await import("../src/agents/subagents/registry/subagent-registry-deps.js");
  const registry = await import("../src/agents/subagents/registry/subagent-registry.js");
  const sqliteStore =
    await import("../src/agents/subagents/registry/subagent-registry.store.sqlite.js");
  const lanePark = await import("../src/agents/subagents/registry/subagent-registry-lane-park.js");
  const queue = await import("../src/process/command-queue.js");
  const laneAvailability =
    await import("../src/agents/embedded-agent-runner/session-lane-availability.js");

  const announceCalls: Array<{ runId: string; at: number }> = [];
  registryDeps.setSubagentRegistryDepsForTest({
    // Edge stub: the outbound announce sink. It records when the production
    // path actually reached it, which is the quantity being proved.
    runSubagentAnnounceFlow: (async (params: { childRunId: string }) => {
      announceCalls.push({ runId: params.childRunId, at: Date.now() });
      return { delivered: true, announcedAt: Date.now() };
    }) as never,
  });

  const requesterSessionKey = "agent:main:main";
  const storePath = paths.resolveSessionStorePathCore(undefined, { agentId: "main" });

  const buildRow = (runId: string, nextAttemptAt?: number): SubagentRunRecord => {
    const now = Date.now();
    return {
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey,
      requesterDisplayKey: "main",
      task: "finish the report",
      cleanup: "keep",
      createdAt: now - 5_000,
      execution: {
        status: "terminal",
        startedAt: now - 5_000,
        endedAt: now,
        outcome: { status: "ok" },
      },
      expectsCompletionMessage: true,
      completion: { required: true },
      cleanupHandled: false,
      delivery: {
        status: "pending",
        attemptCount: 0,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      },
    } as unknown as SubagentRunRecord;
  };

  const rows = new Map<string, SubagentRunRecord>();
  const seed = async (runId: string, nextAttemptAt?: number) => {
    const row = buildRow(runId, nextAttemptAt);
    await sessions.replaceSessionEntry({ storePath, sessionKey: row.childSessionKey }, {
      sessionId: `session-${runId}`,
      updatedAt: Date.now(),
    } as never);
    rows.set(runId, row);
    registryState.persistSubagentRunsToDiskOrThrow(rows);
    return row;
  };

  const announcesFor = (runId: string) => announceCalls.filter((call) => call.runId === runId);

  // Seed every row before the single durable restore the registry performs.
  await seed("park-gated", Date.now() + 60_000);
  await seed("park-cleared");
  await seed("park-live");
  registry.initSubagentRegistry();

  const gated = registry.getSubagentRunByRunId("park-gated");
  const cleared = registry.getSubagentRunByRunId("park-cleared");
  const live = registry.getSubagentRunByRunId("park-live");
  assert.ok(gated && cleared && live, "durable restore did not produce the three rows");

  console.log("── scenario 1: PRE-FIX CONTROL — real resumer with the backstop deadline set ──");
  {
    const deadline = gated.delivery?.nextAttemptAt;
    console.log(
      `   delivery.nextAttemptAt is ${Math.round(((deadline ?? 0) - Date.now()) / 1000)}s out`,
    );
    registry.resumeSubagentRun("park-gated");
    await sleep(600);
    check("the real resumer starts no announce — the reported 60s stall", () => {
      assert.equal(
        announcesFor("park-gated").length,
        0,
        "expected the not-before gate to hold the announce",
      );
      assert.ok(gated.delivery?.nextAttemptAt !== undefined, "deadline should still be set");
    });
  }

  console.log("── scenario 2: the same real resumer, deadline retired ──");
  {
    registry.resumeSubagentRun("park-cleared");
    await sleep(600);
    check("the announce starts once nothing gates it", () => {
      assert.equal(
        announcesFor("park-cleared").length,
        1,
        "expected exactly one announce for the ungated row",
      );
    });
  }

  console.log("── scenario 3: END TO END — real lane hold, real park, real release ──");
  {
    let releaseTurn: (() => void) | undefined;
    const requesterTurn = queue.enqueueCommandInLane(
      laneAvailability.readSessionLaneAvailability(requesterSessionKey).lane,
      async () => {
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
      },
    );
    // Wait until the requester's turn is genuinely RUNNING on its lane, not
    // merely queued behind it — a queued task already reads as "busy", and
    // other lane work can hold the slot first.
    for (let i = 0; i < 500 && !releaseTurn; i += 1) {
      await sleep(10);
    }
    const heldLane = laneAvailability.readSessionLaneAvailability(requesterSessionKey);
    assert.ok(
      heldLane.activeCount > 0 && heldLane.busy,
      `requester lane never became busy (${JSON.stringify(heldLane)}); the scenario would prove nothing`,
    );
    console.log(
      `   requester lane ${heldLane.lane}: active=${heldLane.activeCount} busy=${heldLane.busy}`,
    );

    const waiters = new Map<string, () => void>();
    const persistedRunIds: string[] = [];
    const context = {
      options: {
        runs: rows,
        resumedRuns: new Set<string>(),
        // Real durable write, so the cleared deadline can be re-read from disk.
        persist: (runId: string) => {
          persistedRunIds.push(runId);
          registryState.persistSubagentRunsToDiskOrThrow(rows, [runId]);
        },
        resumeSubagentRun: registry.resumeSubagentRun,
      },
      addScheduledResumeTimer: (timer: ReturnType<typeof setTimeout>) => void timer.unref?.(),
      deleteScheduledResumeTimer: () => {},
      setRequesterLaneReleaseWaiter: (runId: string, unsubscribe: () => void) => {
        waiters.get(runId)?.();
        waiters.set(runId, unsubscribe);
      },
      takeRequesterLaneReleaseWaiter: (runId: string) => {
        const unsubscribe = waiters.get(runId);
        waiters.delete(runId);
        return unsubscribe;
      },
    } as unknown as LifecycleContext;

    // The registry's restored row is the object the resumer will read; park the
    // same object so this is one row end to end, not a copy.
    rows.set("park-live", live);
    const parkedAt = Date.now();
    lanePark.parkAnnounceForRequesterLane(context, {
      runId: "park-live",
      entry: live,
      now: parkedAt,
    });

    const parkedDeadline = live.delivery?.nextAttemptAt;
    check("park arms the backstop deadline and the lane waiter, and announces nothing", () => {
      assert.equal(
        announcesFor("park-live").length,
        0,
        "park must not announce while lane is busy",
      );
      assert.ok(waiters.has("park-live"), "lane-release waiter was not armed");
      assert.ok(parkedDeadline !== undefined, "backstop deadline was not armed");
      assert.ok(
        Math.abs((parkedDeadline ?? 0) - (parkedAt + lanePark.REQUESTER_LANE_BUSY_BACKSTOP_MS)) <
          1_000,
        "backstop deadline is not the documented 60s cadence",
      );
    });

    const releasedAt = Date.now();
    assert.ok(releaseTurn, "requester turn never began executing on its lane");
    releaseTurn();
    await requesterTurn;
    for (let i = 0; i < 200 && announcesFor("park-live").length === 0; i += 1) {
      await sleep(10);
    }
    const announcedAt = announcesFor("park-live")[0]?.at;
    const latencyMs = announcedAt === undefined ? undefined : announcedAt - releasedAt;
    console.log(`   release -> announce latency: ${latencyMs ?? "never"} ms`);
    console.log(`   backstop cadence it must beat: ${lanePark.REQUESTER_LANE_BUSY_BACKSTOP_MS} ms`);

    check("the announce starts at the turn boundary, not at the backstop", () => {
      assert.ok(latencyMs !== undefined, "announce never started after the lane released");
      assert.ok(
        latencyMs < RELEASE_LATENCY_BUDGET_MS,
        `release-to-announce latency ${latencyMs}ms is not prompt`,
      );
      assert.ok(
        latencyMs < lanePark.REQUESTER_LANE_BUSY_BACKSTOP_MS / 10,
        `latency ${latencyMs}ms is within backstop range; the edge did not bypass the deadline`,
      );
    });

    check("the release path retires the deadline in memory", () => {
      assert.equal(
        live.delivery?.nextAttemptAt,
        undefined,
        "release wake left the not-before gate set",
      );
    });

    check("the release path persists that transition durably", () => {
      assert.ok(
        persistedRunIds.includes("park-live"),
        "release wake did not persist the cleared deadline",
      );
      const durable = sqliteStore.loadSubagentRegistryFromSqlite().get("park-live");
      assert.ok(durable, "durable row disappeared");
      assert.equal(
        durable?.delivery?.nextAttemptAt,
        undefined,
        "durable row still carries the retired deadline; a restart would re-gate it",
      );
    });

    check("exactly one announce ran for the released row", () => {
      assert.equal(announcesFor("park-live").length, 1);
    });
  }

  console.log("── scenario 4: the timer backstop is not weakened ──");
  {
    check("park still arms a 60s backstop for listeners the edge cannot cover", () => {
      // Scenario 3 asserted the armed value; restate the contract explicitly so
      // a future change that drops the timer fails here rather than silently.
      assert.equal(lanePark.REQUESTER_LANE_BUSY_BACKSTOP_MS, 60_000);
      assert.equal(
        lanePark.PARKED_FOR_REQUESTER_LANE_ERROR,
        "announce deferred: requester session lane busy",
      );
    });
  }

  if (failures > 0) {
    console.log(`\n${failures} runtime assertion(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll runtime assertions passed.");
  process.exit(0);
}

await main();
