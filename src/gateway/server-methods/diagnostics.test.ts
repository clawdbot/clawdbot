/**
 * Tests for gateway diagnostics methods and their request-handler responses.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../../logging/diagnostic-stability.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { getCommandLaneDiagnostics } from "../../process/command-lane-diagnostics.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { diagnosticsHandlers } from "./diagnostics.js";

type LaneDiagnosticsPayload = {
  ts: number;
} & ReturnType<typeof getCommandLaneDiagnostics>;

async function requestLaneDiagnostics(): Promise<LaneDiagnosticsPayload> {
  const respond = vi.fn();
  await expectDefined(
    diagnosticsHandlers["diagnostics.lanes"],
    'diagnosticsHandlers["diagnostics.lanes"] test invariant',
  )({
    req: { type: "req", id: "lanes", method: "diagnostics.lanes", params: {} },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    context: {} as never,
    respond,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0]?.[1] as LaneDiagnosticsPayload;
}

describe("diagnostics gateway methods", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    startDiagnosticStabilityRecorder();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    vi.useRealTimers();
  });

  it("returns a filtered stability snapshot", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 1024,
      limitBytes: 512,
    });

    const respond = vi.fn();
    await expectDefined(
      diagnosticsHandlers["diagnostics.stability"],
      'diagnosticsHandlers["diagnostics.stability"] test invariant',
    )({
      req: { type: "req", id: "1", method: "diagnostics.stability", params: {} },
      params: { type: "payload.large", limit: 10 },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const firstRespondCall = respond.mock.calls[0];
    expect(firstRespondCall).toEqual([
      true,
      {
        generatedAt: now.toISOString(),
        capacity: 1000,
        count: 1,
        dropped: 0,
        firstSeq: 2,
        lastSeq: 2,
        events: [
          {
            seq: 2,
            ts: now.getTime(),
            type: "payload.large",
            surface: "gateway.http.json",
            action: "rejected",
            bytes: 1024,
            limitBytes: 512,
            count: undefined,
            channel: undefined,
            pluginId: undefined,
          },
        ],
        summary: {
          byType: { "payload.large": 1 },
          payloadLarge: {
            count: 1,
            rejected: 1,
            truncated: 0,
            chunked: 0,
            bySurface: { "gateway.http.json": 1 },
          },
        },
      },
      undefined,
    ]);
    expect(Object.keys(firstRespondCall?.[1] as Record<string, unknown>).toSorted()).toEqual([
      "capacity",
      "count",
      "dropped",
      "events",
      "firstSeq",
      "generatedAt",
      "lastSeq",
      "summary",
    ]);
  });

  it("rejects invalid stability params", async () => {
    const respond = vi.fn();
    await expectDefined(
      diagnosticsHandlers["diagnostics.stability"],
      'diagnosticsHandlers["diagnostics.stability"] test invariant',
    )({
      req: { type: "req", id: "1", method: "diagnostics.stability", params: {} },
      params: { limit: 0 },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "limit must be between 1 and 1000",
        },
      ],
    ]);
  });

  it("reports static lanes in sorted order and hides disabled lanes only after work drains", async () => {
    const lane = CommandLane.HookDispatch;
    const originalConcurrency = getCommandLaneSnapshot(lane).maxConcurrent;
    setCommandLaneConcurrency(lane, 1);

    const activeStarted = createDeferred();
    const activeRelease = createDeferred();
    const active = enqueueCommandInLane(lane, async () => {
      activeStarted.resolve();
      await activeRelease.promise;
    });
    await activeStarted.promise;
    let queued: Promise<void> | undefined;

    try {
      setCommandLaneConcurrency(lane, 0);
      expect((await requestLaneDiagnostics()).lanes).toContainEqual(
        expect.objectContaining({ lane, activeCount: 1, queuedCount: 0, maxConcurrent: 0 }),
      );
      setCommandLaneConcurrency(lane, 1);
      queued = enqueueCommandInLane(lane, async () => undefined);
      const payload = await requestLaneDiagnostics();
      expect(payload.ts).toBeGreaterThan(0);
      expect(payload.lanes.map((snapshot) => snapshot.lane)).toEqual([
        CommandLane.Background,
        CommandLane.Cron,
        CommandLane.CronNested,
        CommandLane.HookDispatch,
        CommandLane.Main,
        CommandLane.Nested,
        CommandLane.Subagent,
        CommandLane.SystemAgent,
      ]);
      expect(payload.lanes).toContainEqual(
        expect.objectContaining({
          lane,
          activeCount: 1,
          queuedCount: 1,
          maxConcurrent: 1,
          blockedBy: "lane",
        }),
      );

      setCommandLaneConcurrency(lane, 0);
      activeRelease.resolve();
      await active;
      expect((await requestLaneDiagnostics()).lanes).toContainEqual(
        expect.objectContaining({ lane, activeCount: 0, queuedCount: 1, maxConcurrent: 0 }),
      );

      setCommandLaneConcurrency(lane, 1);
      await queued;
      expect((await requestLaneDiagnostics()).lanes).toContainEqual(
        expect.objectContaining({ lane, activeCount: 0, queuedCount: 0, maxConcurrent: 1 }),
      );

      setCommandLaneConcurrency(lane, 0);
      expect((await requestLaneDiagnostics()).lanes.map((snapshot) => snapshot.lane)).not.toContain(
        lane,
      );
    } finally {
      activeRelease.resolve();
      setCommandLaneConcurrency(lane, 1);
      await Promise.all([active, queued]);
      setCommandLaneConcurrency(lane, originalConcurrency);
    }
  });

  it("reports background owners once in the aggregate without duplicating dynamic lanes", async () => {
    const before = await requestLaneDiagnostics();
    const owner = createBackgroundWorkOwner({ owner: "core:diagnostics-test", maxConcurrent: 1 });
    const gate = createDeferred();
    const active = owner.enqueue(async () => await gate.promise);
    const queued = owner.enqueue(async () => undefined);
    try {
      const payload = await requestLaneDiagnostics();
      expect(payload.lanes.find((snapshot) => snapshot.lane === "background")).toMatchObject({
        activeCount: 1,
        queuedCount: 1,
        maxConcurrent: 3,
        blockedBy: "lane",
      });
      expect(payload.lanes.some((snapshot) => snapshot.lane === owner.lane)).toBe(false);
      expect(payload.dynamic).toEqual(before.dynamic);
    } finally {
      gate.resolve();
      await Promise.all([active, queued]);
    }
  });

  it("aggregates saturated dynamic session lanes without exporting their names", async () => {
    const lane = `session:test-${Date.now()}`;
    const before = await requestLaneDiagnostics();
    setCommandLaneConcurrency(lane, 1);

    const activeStarted = createDeferred();
    const activeRelease = createDeferred();
    const active = enqueueCommandInLane(lane, async () => {
      activeStarted.resolve();
      await activeRelease.promise;
    });
    await activeStarted.promise;
    const queued = enqueueCommandInLane(lane, async () => undefined);

    try {
      const payload = await requestLaneDiagnostics();
      const baseline = before.dynamic ?? {
        laneCount: 0,
        activeCount: 0,
        queuedCount: 0,
        queuedLaneCount: 0,
      };
      expect(payload.lanes.map((snapshot) => snapshot.lane)).not.toContain(lane);
      expect(payload.dynamic).toEqual({
        laneCount: baseline.laneCount + 1,
        activeCount: baseline.activeCount + 1,
        queuedCount: baseline.queuedCount + 1,
        queuedLaneCount: baseline.queuedLaneCount + 1,
      });
    } finally {
      activeRelease.resolve();
      await Promise.all([active, queued]);
    }
  });
});
