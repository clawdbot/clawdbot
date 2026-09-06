// Microsoft Teams tests cover durable claim ownership through inbound debounce.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { createMSTeamsIngress } from "../msteams-ingress.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();

function createLifecycle(): MSTeamsIngressLifecycle & {
  adoptedCount: () => number;
  abandonedCount: () => number;
} {
  let adopted = 0;
  let abandoned = 0;
  return {
    abortSignal: new AbortController().signal,
    onAdopted: async () => {
      adopted += 1;
    },
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: async () => {
      abandoned += 1;
    },
    adoptedCount: () => adopted,
    abandonedCount: () => abandoned,
  };
}

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

function directActivity(id: string, text: string): MSTeamsTurnContext["activity"] {
  return {
    ...buildChannelActivity({
      id,
      text,
      conversation: { id: "dm-conversation", conversationType: "personal" },
      channelData: {},
      entities: [],
    }),
  } as MSTeamsTurnContext["activity"];
}

function createHandler(cfg: OpenClawConfig) {
  const { deps } = createMessageHandlerDeps(cfg, {
    createInboundDebouncer,
    resolveInboundDebounceMs: vi.fn(() => 40),
  });
  return createMSTeamsMessageHandler(deps);
}

describe("Microsoft Teams drain claim ownership", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("changes batching timing without replacing the Microsoft Teams handler", async () => {
    const cfg: OpenClawConfig = {
      messages: { inbound: { debounceMs: 0 } },
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const debouncers: Array<{ drain: () => Promise<void> }> = [];
    const createDebouncer: typeof createInboundDebouncer = (options) => {
      const debouncer = createInboundDebouncer(options);
      debouncers.push(debouncer);
      return debouncer;
    };
    const { deps } = createMessageHandlerDeps(cfg, {
      createInboundDebouncer: createDebouncer,
      resolveInboundDebounceMs,
    });
    const handler = createMSTeamsMessageHandler(deps);
    const dispatch = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
    const publish = (debounceMs: number) => {
      const current = { ...cfg, messages: { inbound: { debounceMs } } };
      setRuntimeConfigSnapshot(current, current);
    };
    try {
      await handler(context(directActivity("initial", "immediate")), createLifecycle());
      expect(dispatch).toHaveBeenCalledTimes(1);
      publish(250);
      const started = performance.now();
      await handler(context(directActivity("first", "part one")), createLifecycle());
      await handler(context(directActivity("second", "part two")), createLifecycle());
      expect(dispatch).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
      const delayedElapsedMs = performance.now() - started;
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            BodyForAgent: expect.stringContaining("part one\npart two"),
          }),
        }),
      );
      publish(0);
      await handler(context(directActivity("last", "after disable")), createLifecycle());
      expect(dispatch).toHaveBeenCalledTimes(3);
      console.log(
        "MONITOR_DEBOUNCE_PROOF " +
          JSON.stringify({
            channel: "msteams",
            pid: process.pid,
            clock: "real",
            delaysMs: [0, 250, 0],
            delayedElapsedMs,
            dispatches: dispatch.mock.calls.length,
            debouncersCreated: debouncers.length,
          }),
      );
    } finally {
      await Promise.all(debouncers.map((debouncer) => debouncer.drain()));
      clearRuntimeConfigSnapshot();
    }
  });

  it("defers a claimed activity and binds completion to reply adoption", async () => {
    const handler = createHandler({
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig);
    const lifecycle = createLifecycle();

    const result = await handler(context(directActivity("activity-one", "hello")), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(
      () => {
        expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
          1,
        );
        expect(lifecycle.adoptedCount()).toBe(1);
      },
      { timeout: 5_000 },
    );
    const dispatchParams = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock
      .calls[0]?.[0] as
      | { replyOptions?: { turnAdoptionLifecycle?: { admission?: string } } }
      | undefined;
    expect(dispatchParams?.replyOptions?.turnAdoptionLifecycle).toMatchObject({
      admission: "exclusive",
    });
    expect(lifecycle.abandonedCount()).toBe(0);
  });

  it("fans merged-flush adoption to every constituent claim", async () => {
    const handler = createHandler({
      messages: { inbound: { debounceMs: 40 } },
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig);
    const first = createLifecycle();
    const second = createLifecycle();

    const results = [
      await handler(context(directActivity("activity-first", "part one")), first),
      await handler(context(directActivity("activity-second", "part two")), second),
    ];

    expect(results).toEqual([{ kind: "deferred" }, { kind: "deferred" }]);
    await vi.waitFor(
      () => {
        expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
          1,
        );
        expect(first.adoptedCount()).toBe(1);
        expect(second.adoptedCount()).toBe(1);
      },
      { timeout: 5_000 },
    );
    const dispatchParams = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock
      .calls[0]?.[0] as { ctx?: { BodyForAgent?: string } } | undefined;
    expect(dispatchParams?.ctx?.BodyForAgent).toContain("part one\npart two");
    expect(first.abandonedCount()).toBe(0);
    expect(second.abandonedCount()).toBe(0);
  });

  it("completes a gated no-dispatch turn instead of stalling its claim", async () => {
    const { deps } = createMessageHandlerDeps(
      {
        channels: {
          msteams: {
            groupPolicy: "open",
            requireMention: true,
          },
        },
      } as OpenClawConfig,
      {
        createInboundDebouncer,
        resolveInboundDebounceMs: vi.fn(() => 20),
      },
    );
    const handler = createMSTeamsMessageHandler(deps);
    const lifecycle = createLifecycle();
    const gatedActivity = buildChannelActivity({
      id: "activity-gated",
      text: "not for the bot",
      entities: [],
    }) as MSTeamsTurnContext["activity"];

    const result = await handler(context(gatedActivity), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.adoptedCount()).toBe(1), { timeout: 5_000 });
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(lifecycle.abandonedCount()).toBe(0);
  });

  it("preserves abandon retry accounting, backoff, threshold, and restart behavior", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-abandon-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "msteams",
      accountId: "test-app",
      stateDir,
    });
    const incoming = directActivity("activity-abandon", "retry me");
    await queue.enqueue(
      "activity-abandon",
      { version: 1, receivedAt: now - 2 * 24 * 60 * 60_000, rawActivity: JSON.stringify(incoming) },
      { laneKey: "dm-conversation", receivedAt: now - 2 * 24 * 60 * 60_000 },
    );
    const dispatchMock = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
    const priorImplementation = dispatchMock.getMockImplementation();
    dispatchMock.mockRejectedValue(new Error("Microsoft Teams dispatch failed before adoption"));

    const createIntegratedIngress = () => {
      const handler = createHandler({
        channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
      } as OpenClawConfig);
      return createMSTeamsIngress({
        accountId: "test-app",
        queue,
        runtime: { error: vi.fn(), log: vi.fn() },
        dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
      });
    };
    const expectPendingAttempt = async (attempts: number) => {
      let observed: Awaited<ReturnType<typeof queue.listPending>>[number] | undefined;
      await vi.waitFor(async () => {
        const pending = await queue.listPending({ limit: "all" });
        expect(pending).toEqual([
          expect.objectContaining({
            id: "activity-abandon",
            attempts,
            lastAttemptAt: expect.any(Number),
            lastError: "turn-abandoned",
          }),
        ]);
        observed = pending[0];
      });
      const lastAttemptAt = observed?.lastAttemptAt;
      if (lastAttemptAt === undefined) {
        throw new Error(`Missing Microsoft Teams retry timestamp for attempt ${attempts}`);
      }
      return { ...observed, lastAttemptAt };
    };

    try {
      const first = createIntegratedIngress();
      first.start();
      const firstAttempt = await expectPendingAttempt(1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      await first.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 999);
      const second = createIntegratedIngress();
      second.start();
      await second.accept(incoming);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      await second.stop();
      vi.setSystemTime(firstAttempt.lastAttemptAt + 1_001);
      const afterBackoff = createIntegratedIngress();
      afterBackoff.start();
      await afterBackoff.accept(incoming);
      const secondAttempt = await expectPendingAttempt(2);
      expect(dispatchMock).toHaveBeenCalledTimes(2);
      await afterBackoff.stop();

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("activity-abandon", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Microsoft Teams seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }
      vi.setSystemTime(secondAttempt.lastAttemptAt + 64_001);
      const threshold = createIntegratedIngress();
      threshold.start();
      await threshold.accept(incoming);
      const thresholdAttempt = await expectPendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS);
      expect(dispatchMock).toHaveBeenCalledTimes(3);
      await threshold.stop();

      vi.setSystemTime(thresholdAttempt.lastAttemptAt + 128_001);
      const beyond = createIntegratedIngress();
      beyond.start();
      await beyond.accept(incoming);
      const beyondAttempt = await expectPendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1);
      expect(dispatchMock).toHaveBeenCalledTimes(4);
      await beyond.stop();

      vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000);
      const blockedRestart = createIntegratedIngress();
      blockedRestart.start();
      await blockedRestart.accept(incoming);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchMock).toHaveBeenCalledTimes(4);
      await blockedRestart.stop();
    } finally {
      dispatchMock.mockReset();
      if (priorImplementation) {
        dispatchMock.mockImplementation(priorImplementation);
      }
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
