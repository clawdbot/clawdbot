import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  resetWorkingProgress,
  resolveTurnRecap,
  resolveWorkingProgress,
  type TurnRecapWatch,
} from "./chat-progress.ts";

const SESSION = "agent:main:main";

describe("resolveWorkingProgress", () => {
  beforeEach(() => resetWorkingProgress());
  afterEach(() => resetWorkingProgress());

  it.each(["failed", "unconfirmed", "waiting-idle"] as const)(
    "does not let an older %s send identify an unknown active turn",
    (sendState) => {
      expect(
        resolveWorkingProgress(
          SESSION,
          null,
          2_000,
          [
            {
              id: "old-send",
              text: "Review this send",
              createdAt: 1_000,
              sendRunId: "old-run",
              sendAttempts: 1,
              sendState,
              sendError: "Review required",
            },
          ],
          [],
          [],
        ),
      ).toMatchObject({ runId: null, startedAt: 2_000 });
    },
  );

  it("uses only the matching reconnect send when restoring an active turn", () => {
    const queue = ["other-run", "active-run"].map((sendRunId, index) => ({
      id: sendRunId,
      text: "Reconnect send",
      createdAt: (index + 1) * 1_000,
      sendRunId,
      sendState: "waiting-reconnect" as const,
      sendAttempts: 1,
    }));
    expect(resolveWorkingProgress(SESSION, "active-run", 3_000, queue, [], [])).toMatchObject({
      runId: "active-run",
      startedAt: 2_000,
    });
  });

  it.each(["failed", "unconfirmed", "waiting-idle"] as const)(
    "retains matching durable timing from a %s send after the run is identified",
    (sendState) => {
      const queue = ["old-run", "active-run"].map((sendRunId, index) => ({
        id: sendRunId,
        text: "Retained attempted send",
        createdAt: (index + 1) * 1_000,
        sendRunId,
        sendState,
        sendAttempts: 1,
        sendError: "Review required",
      }));
      expect(resolveWorkingProgress(SESSION, "active-run", 3_000, queue, [], [])).toMatchObject({
        runId: "active-run",
        startedAt: 2_000,
      });
    },
  );

  it("keeps a submitted turn's identity and timing across a delayed foreign preamble", () => {
    const queue = [
      {
        id: "new-send",
        text: "New turn",
        createdAt: 60_000,
        sendRunId: "new-run",
        sendState: "sending" as const,
        sendAttempts: 1,
      },
    ];
    const submitted = resolveWorkingProgress(SESSION, null, null, queue, [], []);
    const segments = [{ runId: "old-run", ts: 1_000 }];
    expect(resolveWorkingProgress(SESSION, null, null, queue, segments, [])).toEqual(submitted);
    expect(resolveWorkingProgress(SESSION, "new-run", 61_000, [], segments, [])).toEqual(submitted);
    expect(submitted).toMatchObject({ runId: "new-run", startedAt: 60_000 });
  });

  it("preserves anonymous progress when the same turn gains an identity", () => {
    const anonymous = resolveWorkingProgress(SESSION, null, null, [], [{ ts: 1_000 }], []);
    expect(resolveWorkingProgress(SESSION, "active-run", 2_000, [], [{ ts: 1_000 }], [])).toEqual({
      ...anonymous,
      runId: "active-run",
    });
  });

  it.each(["other-run", undefined])(
    "ignores stream and tool timing without matching ownership (%s)",
    (runId) => {
      expect(
        resolveWorkingProgress(
          SESSION,
          "active-run",
          3_000,
          [],
          [
            { runId, ts: 500 },
            { runId: "active-run", ts: 2_000 },
          ],
          [
            { runId, __openclawToolStreamReceivedAt: 100 },
            { runId: "active-run", __openclawToolStreamReceivedAt: 2_500 },
          ],
        ),
      ).toMatchObject({ runId: "active-run", startedAt: 2_000 });
    },
  );

  it("prefers observed stream identity over a future queued send", () => {
    expect(
      resolveWorkingProgress(
        SESSION,
        null,
        1_000,
        [
          {
            id: "future-send",
            text: "Run next",
            createdAt: 500,
            sendRunId: "future-run",
            sendState: "waiting-reconnect",
            sendAttempts: 1,
          },
        ],
        [{ ts: 1_000, runId: "active-run" }],
        [],
      ),
    ).toMatchObject({ runId: "active-run", startedAt: 1_000 });
  });
});

describe("resolveTurnRecap", () => {
  let host: { turnRecapWatch: TurnRecapWatch | null };
  const runId = "watched-run";
  const doneRow = { lastRunId: runId, status: "done" as const, runtimeMs: 14_000 };
  const usage = (outputTokens: number, owner = runId) =>
    new Map([[owner, { outputTokens, seq: 1 }]]);
  const resolve = (params: Omit<Parameters<typeof resolveTurnRecap>[1], "sessionKey"> = {}) =>
    resolveTurnRecap(host, { sessionKey: SESSION, ...params });
  const watch = () => resolve({ indicator: { runId } });

  beforeEach(() => {
    host = { turnRecapWatch: null };
  });

  it("matches the watched run instead of inferring identity from session-row values", () => {
    expect(watch()).toBeNull();
    expect(
      resolve({ row: { ...doneRow, lastRunId: "previous-run" }, usageByRun: usage(690) }),
    ).toBeNull();
    expect(resolve({ row: doneRow, usageByRun: usage(690) })).toEqual({
      runId,
      runtimeMs: 14_000,
      outputTokens: 690,
    });
  });

  it("reconciles usage arriving after the first completed recap", () => {
    watch();
    expect(resolve({ row: doneRow, usageByRun: usage(690) })).toEqual({
      runId,
      runtimeMs: 14_000,
      outputTokens: 690,
    });
    expect(resolve({ row: doneRow, usageByRun: usage(695) })).toEqual({
      runId,
      runtimeMs: 14_000,
      outputTokens: 695,
    });
    expect(resolve({ row: doneRow, usageByRun: usage(680) })).toEqual({
      runId,
      runtimeMs: 14_000,
      outputTokens: 680,
    });
  });

  it("retains a matching terminal that arrives before the indicator disappears", () => {
    expect(resolve({ indicator: { runId }, row: doneRow, usageByRun: usage(695) })).toBeNull();
    expect(resolve()).toEqual({ runId, runtimeMs: 14_000, outputTokens: 695 });
  });

  it("keeps a resolved recap against unwatched terminal rows and usage", () => {
    watch();
    const recap = resolve({ row: doneRow, usageByRun: usage(695) });
    expect(
      resolve({
        row: { ...doneRow, lastRunId: "foreign-run", runtimeMs: 1_000 },
        usageByRun: usage(900, "foreign-run"),
      }),
    ).toEqual(recap);
  });

  it("waits for runtime data without borrowing another run's count", () => {
    watch();
    expect(
      resolve({ row: { lastRunId: runId, status: "done" }, usageByRun: usage(900, "foreign-run") }),
    ).toBeNull();
    expect(resolve({ row: doneRow, usageByRun: usage(900, "foreign-run") })).toEqual({
      runId,
      runtimeMs: 14_000,
      outputTokens: null,
    });
  });

  it("reports equal counts on consecutive runs and preserves a known zero", () => {
    watch();
    expect(resolve({ row: doneRow, usageByRun: usage(0) })?.outputTokens).toBe(0);
    const nextRunId = "next-run";
    expect(resolve({ indicator: { runId: nextRunId }, row: doneRow })).toBeNull();
    expect(resolve({ row: doneRow })).toBeNull();
    expect(
      resolve({ row: { ...doneRow, lastRunId: nextRunId }, usageByRun: usage(0, nextRunId) }),
    ).toEqual({ runId: nextRunId, runtimeMs: 14_000, outputTokens: 0 });
  });

  it.each(["failed", "timeout", "killed"] as const)(
    "stays quiet for a watched %s run",
    (status) => {
      watch();
      expect(resolve({ row: { ...doneRow, status }, usageByRun: usage(695) })).toBeNull();
      expect(
        resolve({
          row: { ...doneRow, lastRunId: "foreign-run" },
          usageByRun: usage(900, "foreign-run"),
        }),
      ).toBeNull();
    },
  );

  it("never invents a watch from history or an unidentified queued indicator", () => {
    expect(resolve({ row: doneRow, usageByRun: usage(695) })).toBeNull();
    expect(resolve({ indicator: {}, row: doneRow })).toBeNull();
    expect(resolve({ row: doneRow, usageByRun: usage(695) })).toBeNull();
  });

  it("clears the previous recap when a new queued turn has no run identity yet", () => {
    watch();
    expect(resolve({ row: doneRow, usageByRun: usage(695) })).not.toBeNull();
    expect(resolve({ indicator: {}, row: doneRow })).toBeNull();
    expect(resolve({ row: doneRow, usageByRun: usage(695) })).toBeNull();
  });

  it.each(["agent", "gateway"])(
    "invalidates a settled global recap when its %s changes",
    (owner) => {
      const params = {
        sessionKey: "global",
        agentId: "first",
        gatewayClient: createTestGatewayClient(() => null),
        usageByRun: usage(695),
      };
      resolveTurnRecap(host, { ...params, indicator: { runId } });
      expect(resolveTurnRecap(host, { ...params, row: doneRow })).not.toBeNull();
      const replacement =
        owner === "agent"
          ? { ...params, agentId: "second" }
          : { ...params, gatewayClient: createTestGatewayClient(() => null) };
      expect(resolveTurnRecap(host, { ...replacement, row: doneRow })).toBeNull();
      expect(resolveTurnRecap(host, { ...params, row: doneRow })).toBeNull();
    },
  );

  it("isolates watches by pane and resets them on session changes", () => {
    const other = { turnRecapWatch: null };
    watch();
    const params = { sessionKey: SESSION, row: doneRow, usageByRun: usage(695) };
    expect(resolveTurnRecap(other, params)).toBeNull();
    expect(resolveTurnRecap(host, params)).not.toBeNull();
    expect(resolveTurnRecap(host, { ...params, sessionKey: "other-session" })).toBeNull();
    expect(resolveTurnRecap(host, params)).toBeNull();
  });
});
