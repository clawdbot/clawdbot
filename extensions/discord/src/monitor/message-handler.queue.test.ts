// Discord tests cover message handler.queue plugin behavior.
import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { APIMessage } from "discord-api-types/v10";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  type ChannelIngressQueue,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiscordInboundJob } from "./inbound-job.js";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";
import { createDiscordMessageHandler as createDurableDiscordMessageHandler } from "./message-handler.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";
import { createDiscordMessageRunQueue } from "./message-run-queue.js";

type SetStatusFn = (patch: Record<string, unknown>) => void;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
function mockCalls(source: MockCallSource): Array<Array<unknown>> {
  return source.mock.calls;
}

function statusPatches(setStatus: MockCallSource) {
  return setStatus.mock.calls.map(([patch]) => patch as Record<string, unknown>);
}

function expectStatusPatch(setStatus: MockCallSource, expected: Record<string, unknown>) {
  expect(
    statusPatches(setStatus).some((patch) =>
      Object.entries(expected).every(([key, value]) => patch[key] === value),
    ),
  ).toBe(true);
}

function createIngressLifecycle(): DiscordIngressLifecycle & {
  onAdopted: ReturnType<typeof vi.fn>;
  onFailed: ReturnType<typeof vi.fn>;
  onCancelled: ReturnType<typeof vi.fn>;
  onAbandoned: ReturnType<typeof vi.fn>;
} {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onFailed: vi.fn(async () => {}),
    onCancelled: vi.fn(async () => {}),
    onAbandoned: vi.fn(async () => {}),
  };
}

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

async function withDiscordQueue<T>(
  run: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-handler-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
  });
  try {
    return await run(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createRawMessage(id: string, channelId = "ch-1"): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "0",
      avatar: null,
    },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
  } as unknown as APIMessage;
}

async function flushQueueWork(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function createMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [{ id: `att-${messageId}` }],
    },
  };
}

function createTextMessageData(messageId: string, channelId = "ch-1") {
  const data = createMessageData(messageId, channelId);
  data.message.attachments = [];
  return data;
}

function createPreflightContext(channelId = "ch-1") {
  const discordConfig = {
    enabled: true,
    token: "test-token",
    groupPolicy: "allowlist" as const,
  };
  const cfg: OpenClawConfig = {
    channels: {
      discord: discordConfig,
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  return {
    ...createDiscordPreflightContext(channelId),
    cfg,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    textLimit: 2_000,
    replyToMode: "off" as const,
    discordConfig,
    messageText: "hello",
    isDirectMessage: false,
    isGuildMessage: true,
    isGroupDm: false,
    inboundEventKind: "message" as const,
    effectiveWasMentioned: false,
  };
}

function createPreflightContextForMessage(data: { channel_id: string; message: { id: string } }) {
  const ctx = createPreflightContext(data.channel_id);
  return {
    ...ctx,
    message: { ...ctx.message, id: data.message.id },
    data: {
      ...ctx.data,
      message: { ...ctx.data.message, id: data.message.id },
    },
  };
}

function createHandlerWithDefaultPreflight(overrides?: { setStatus?: SetStatusFn }) {
  preflightDiscordMessageMock.mockImplementation(
    async (params: { data: ReturnType<typeof createMessageData> }) =>
      createPreflightContextForMessage(params.data),
  );
  return createDiscordMessageHandler(createDiscordHandlerParams(overrides));
}

function installDefaultDiscordPreflight() {
  preflightDiscordMessageMock.mockImplementation(
    async (params: { data: ReturnType<typeof createMessageData> }) =>
      createPreflightContextForMessage(params.data),
  );
}

async function createLifecycleStopScenario(params: {
  createHandler: (status: SetStatusFn) => {
    handler: (data: never, opts: never) => Promise<unknown>;
    stop: () => void | Promise<void>;
  };
}) {
  preflightDiscordMessageMock.mockImplementation(
    async (preflightParams: { data: { channel_id: string } }) =>
      createPreflightContext(preflightParams.data.channel_id),
  );
  const runInFlight = createDeferred<void>();
  processDiscordMessageMock.mockImplementation(async () => {
    await runInFlight.promise;
  });

  const setStatus = vi.fn<SetStatusFn>();
  const { handler, stop } = params.createHandler(setStatus);

  await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
  await flushQueueWork();
  expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

  const callsBeforeStop = setStatus.mock.calls.length;
  const stopTask = stop();

  return {
    setStatus,
    callsBeforeStop,
    finish: async () => {
      runInFlight.resolve();
      await runInFlight.promise;
      await stopTask;
      await Promise.resolve();
    },
  };
}

describe("createDiscordMessageHandler queue behavior", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("resets busy counters when the handler is created", () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const setStatus = vi.fn();
    createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    expectStatusPatch(setStatus, { activeRuns: 0, busy: false });
  });

  it("starts a second same-session event while the first run is active", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred<void>();
    const secondRun = createDeferred<void>();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
      })
      .mockImplementationOnce(async () => {
        await secondRun.promise;
      });
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: ReturnType<typeof createMessageData> }) =>
        createPreflightContextForMessage(params.data),
    );
    const setStatus = vi.fn();
    const handler = createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expectStatusPatch(setStatus, { activeRuns: 1, busy: true });

    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expectStatusPatch(setStatus, { activeRuns: 2, busy: true });

    secondRun.resolve();
    await secondRun.promise;

    await flushQueueWork();
    expectStatusPatch(setStatus, { activeRuns: 1, busy: true });

    firstRun.resolve();
    await firstRun.promise;

    await flushQueueWork();
    const lastStatusPatch = statusPatches(setStatus).at(-1);
    expect(lastStatusPatch?.activeRuns).toBe(0);
    expect(lastStatusPatch?.busy).toBe(false);
  });

  it("fans merged-turn adoption out to every debounced ingress claim", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: {
        data: { channel_id: string };
        turnAdoptionLifecycle?: unknown;
      }) => ({
        ...createPreflightContext(preflightParams.data.channel_id),
        turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
      }),
    );
    processDiscordMessageMock.mockImplementation(
      async (ctx: { turnAdoptionLifecycle?: DiscordIngressLifecycle }) => {
        await ctx.turnAdoptionLifecycle?.onAdopted();
      },
    );
    const handler = createDiscordMessageHandler(params);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();

    await expect(
      handler(createTextMessageData("m-fanout-1") as never, {} as never, {
        turnAdoptionLifecycle: first,
      }),
    ).resolves.toEqual({ kind: "deferred" });
    await expect(
      handler(createTextMessageData("m-fanout-2") as never, {} as never, {
        turnAdoptionLifecycle: second,
      }),
    ).resolves.toEqual({ kind: "deferred" });

    await vi.waitFor(() => expect(processDiscordMessageMock).toHaveBeenCalledTimes(1));
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("completes every debounced ingress claim when preflight gates the merged turn", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockResolvedValue(null);
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    const handler = createDiscordMessageHandler(params);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();

    await handler(createTextMessageData("m-gated-1") as never, {} as never, {
      turnAdoptionLifecycle: first,
    });
    await handler(createTextMessageData("m-gated-2") as never, {} as never, {
      turnAdoptionLifecycle: second,
    });

    await vi.waitFor(() => expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1));
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("returns retryable, never completed, for a dispatch after shutdown", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler.deactivate();
    const lifecycle = createIngressLifecycle();

    // Completing here would tombstone a message that never dispatched; the
    // claim must release so a restarted drain replays it.
    const result = await handler(createTextMessageData("m-after-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });

    expect(result).toMatchObject({ kind: "deferred" });
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("reports a genuine pre-admission exception only through onFailed", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const failure = new Error("preflight failed");
    preflightDiscordMessageMock.mockRejectedValue(failure);
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const lifecycle = createIngressLifecycle();

    await expect(
      handler(createTextMessageData("m-failed") as never, {} as never, {
        turnAdoptionLifecycle: lifecycle,
      }),
    ).resolves.toEqual({ kind: "deferred" });

    expect(lifecycle.onFailed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("cancels a buffered ingress claim during deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 60_000 } };
    const handler = createDiscordMessageHandler(params);
    const lifecycle = createIngressLifecycle();

    await handler(createTextMessageData("m-cancel") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });
    await handler.deactivate();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("settles every buffered claim when cancellation fan-in includes a legacy lifecycle", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 60_000 } };
    const handler = createDiscordMessageHandler(params);
    const cancellable = createIngressLifecycle();
    const legacy = createIngressLifecycle();
    delete (legacy as Partial<typeof legacy>).onCancelled;

    await handler(createTextMessageData("m-cancel-modern") as never, {} as never, {
      turnAdoptionLifecycle: cancellable,
    });
    await handler(createTextMessageData("m-cancel-legacy") as never, {} as never, {
      turnAdoptionLifecycle: legacy,
    });
    await handler.deactivate();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(cancellable.onCancelled).toHaveBeenCalledTimes(1);
    expect(legacy.onAbandoned).toHaveBeenCalledTimes(1);
    expect(legacy.onAdopted).not.toHaveBeenCalled();
  });

  it("waits for an active debounce flush and cancels it after shutdown", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const preflightGate = createDeferred<void>();
    preflightDiscordMessageMock.mockImplementation(async () => {
      await preflightGate.promise;
      return null;
    });
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const lifecycle = createIngressLifecycle();
    const handling = handler(createTextMessageData("m-active-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });
    await vi.waitFor(() => expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1));

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(deactivated).toBe(false);

    preflightGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("waits for an active durable admission before stopping the drain", async () => {
    const admissionGate = createDeferred<void>();
    const accept = vi.fn(() => admissionGate.promise);
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    const params = createDiscordHandlerParams();
    const handler = createDurableDiscordMessageHandler({
      ...params,
      client: {} as never,
      testing: {
        createIngressMonitor: vi.fn(() => ({ accept, start, stop })),
      },
    });
    const handling = handler({ id: "m-admitting", channel_id: "ch-1" } as never, {} as never);

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(deactivated).toBe(false);

    admissionGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("dead-letters an exhausted preflight failure and releases its Discord lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      await withDiscordQueue(async (queue) => {
        const attempted: string[] = [];
        const preflight = vi.fn(async (params: { data: { message?: { id?: string } } }) => {
          const id = params.data.message?.id ?? "unknown";
          attempted.push(id);
          if (id === "poison") {
            throw new Error("deterministic preflight failure");
          }
          return null;
        });
        const params = createDiscordHandlerParams();
        const handler = createDurableDiscordMessageHandler({
          ...params,
          client: {} as never,
          testing: {
            preflightDiscordMessage: preflight as never,
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue }),
          },
        });
        try {
          await handler(createRawMessage("poison", "lane-a") as never, {} as never);
          await handler(createRawMessage("follower", "lane-a") as never, {} as never);
          await handler(createRawMessage("independent", "lane-b") as never, {} as never);

          for (let attempt = 0; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
            await vi.advanceTimersByTimeAsync(3 * 60_000);
          }

          await vi.waitFor(() => expect(attempted).toContain("follower"));
          expect(attempted.indexOf("independent")).toBeGreaterThanOrEqual(0);
          expect(attempted.indexOf("independent")).toBeLessThan(attempted.indexOf("follower"));
          expect(attempted.filter((id) => id === "poison")).toHaveLength(
            DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          );
          await expect(queue.enqueue("poison", {} as DiscordIngressPayload)).resolves.toMatchObject(
            {
              kind: "failed",
              record: { reason: "retry-limit-exceeded" },
            },
          );
          await expect(
            queue.enqueue("follower", {} as DiscordIngressPayload),
          ).resolves.toMatchObject({ kind: "completed" });
          const runtimeErrors = mockCalls(params.runtime.error as unknown as MockCallSource).map(
            ([message]) => String(message),
          );
          expect(runtimeErrors.some((message) => message.includes("reached retry limit"))).toBe(
            true,
          );
          expect(runtimeErrors.join("\n")).not.toContain("hello");
        } finally {
          await handler.deactivate();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dead-letters an exhausted queued processing failure and releases its Discord lane", async () => {
    vi.useFakeTimers();
    try {
      await withDiscordQueue(async (queue) => {
        const receivedAt = 1;
        const ingressPayload = (id: string): DiscordIngressPayload => ({
          version: 1,
          receivedAt,
          rawMessage: createRawMessage(id, "lane-a"),
        });
        const poisonPayload = ingressPayload("processing-poison");
        const followerPayload = ingressPayload("processing-follower");
        const lane = { laneKey: "channel:lane-a" };
        await queue.enqueue("processing-poison", poisonPayload, { ...lane, receivedAt });
        await queue.enqueue("processing-follower", followerPayload, {
          ...lane,
          receivedAt: receivedAt + 1,
        });
        for (let attempt = 1; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
          const claim = await queue.claim("processing-poison", {
            ownerId: `seed-failure-${attempt}`,
          });
          if (!claim) {
            throw new Error(`failed to seed retry ${attempt}`);
          }
          await queue.release(claim, {
            lastError: `seed processing failure ${attempt}`,
            releasedAt: poisonPayload.receivedAt + attempt,
          });
        }
        const processed: string[] = [];
        const handler = createDurableDiscordMessageHandler({
          ...createDiscordHandlerParams(),
          client: {} as never,
          testing: {
            preflightDiscordMessage: (async (preflightParams: DiscordMessagePreflightParams) => ({
              ...createPreflightContextForMessage(preflightParams.data),
              turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
            })) as never,
            processDiscordMessage: async (ctx) => {
              processed.push(ctx.message.id);
              if (ctx.message.id === "processing-poison") {
                throw new Error("deterministic queued processing failure");
              }
            },
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue }),
          },
        });
        try {
          await vi.advanceTimersByTimeAsync(1_000);
          await vi.waitFor(() => expect(processed).toHaveLength(2));
          expect(processed).toEqual(["processing-poison", "processing-follower"]);
          expect((await queue.listFailed?.())?.[0]?.reason).toBe("retry-limit-exceeded");
        } finally {
          await handler.deactivate();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves retry facts when deactivation cancels a durable Discord claim", async () => {
    await withDiscordQueue(async (queue) => {
      const raw = createRawMessage("cancelled", "lane-a");
      await queue.enqueue(
        "cancelled",
        { version: 1, receivedAt: 10, rawMessage: raw },
        { laneKey: "channel:lane-a", receivedAt: 10 },
      );
      const failedClaim = await queue.claim("cancelled", { ownerId: "failed-owner" });
      expect(failedClaim).not.toBeNull();
      if (!failedClaim) {
        return;
      }
      await queue.release(failedClaim, {
        lastError: "previous genuine failure",
        releasedAt: 20,
      });
      const before = (await queue.listPending())[0];
      const firstPreflight = vi.fn(async () => null);
      const firstParams = createDiscordHandlerParams();
      firstParams.cfg.messages = { inbound: { debounceMs: 60_000 } };
      const first = createDurableDiscordMessageHandler({
        ...firstParams,
        client: {} as never,
        testing: {
          preflightDiscordMessage: firstPreflight as never,
          createIngressMonitor: (monitorParams) =>
            createDiscordIngressMonitor({ ...monitorParams, queue }),
        },
      });

      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(1));
      await first.deactivate();

      expect(firstPreflight).not.toHaveBeenCalled();
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({
          id: "cancelled",
          attempts: before?.attempts,
          lastAttemptAt: before?.lastAttemptAt,
          lastError: before?.lastError,
        }),
      ]);

      const replacementPreflight = vi.fn(async () => null);
      const replacementParams = createDiscordHandlerParams();
      const replacement = createDurableDiscordMessageHandler({
        ...replacementParams,
        client: {} as never,
        testing: {
          preflightDiscordMessage: replacementPreflight as never,
          createIngressMonitor: (monitorParams) =>
            createDiscordIngressMonitor({ ...monitorParams, queue }),
        },
      });
      try {
        await vi.waitFor(() => expect(replacementPreflight).toHaveBeenCalledTimes(1));
        await expect(
          queue.enqueue("cancelled", {} as DiscordIngressPayload),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await replacement.deactivate();
      }
    });
  });

  it.each(["returns", "throws"] as const)(
    "preserves retry facts when a started durable Discord job %s after cancellation",
    async (outcome) => {
      await withDiscordQueue(async (queue) => {
        const id = `started-cancelled-${outcome}`;
        const raw = createRawMessage(id, "lane-a");
        await queue.enqueue(
          id,
          { version: 1, receivedAt: 10, rawMessage: raw },
          { laneKey: "channel:lane-a", receivedAt: 10 },
        );
        const failedClaim = await queue.claim(id, { ownerId: "failed-owner" });
        expect(failedClaim).not.toBeNull();
        if (!failedClaim) {
          return;
        }
        await queue.release(failedClaim, {
          lastError: "previous genuine failure",
          releasedAt: 20,
        });
        const before = (await queue.listPending())[0];
        const processingStarted = createDeferred<void>();
        const finishProcessing = createDeferred<void>();
        let processingSignal: AbortSignal | undefined;
        const processDiscordMessage = vi.fn(async (ctx: { abortSignal?: AbortSignal }) => {
          processingSignal = ctx.abortSignal;
          processingStarted.resolve();
          await finishProcessing.promise;
          if (outcome === "throws") {
            throw new Error("processing stopped after cancellation");
          }
        });
        const params = createDiscordHandlerParams();
        const handler = createDurableDiscordMessageHandler({
          ...params,
          client: {} as never,
          testing: {
            preflightDiscordMessage: (async (preflightParams: {
              abortSignal?: AbortSignal;
              data: ReturnType<typeof createTextMessageData>;
              turnAdoptionLifecycle?: DiscordIngressLifecycle;
            }) => ({
              ...createPreflightContextForMessage(preflightParams.data),
              abortSignal: preflightParams.abortSignal,
              turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
            })) as never,
            processDiscordMessage: processDiscordMessage as never,
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue }),
          },
        });

        await processingStarted.promise;
        const deactivation = handler.deactivate();
        await vi.waitFor(() => expect(processingSignal?.aborted).toBe(true));
        finishProcessing.resolve();
        await deactivation;

        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id,
            attempts: before?.attempts,
            lastAttemptAt: before?.lastAttemptAt,
            lastError: before?.lastError,
          }),
        ]);

        const recovered = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        });
        const replacement = createDiscordIngressMonitor({
          accountId: "default",
          client: {} as never,
          runtime: params.runtime,
          queue,
          dispatch: recovered,
        });
        replacement.start();
        try {
          await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1));
          await expect(queue.enqueue(id, {} as DiscordIngressPayload)).resolves.toMatchObject({
            kind: "completed",
          });
        } finally {
          await replacement.stop();
        }
      });
    },
  );

  it("preserves retry facts when deactivation skips a queued durable Discord job", async () => {
    await withDiscordQueue(async (queue) => {
      const raw = createRawMessage("queued-cancelled", "lane-a");
      await queue.enqueue(
        "queued-cancelled",
        { version: 1, receivedAt: 10, rawMessage: raw },
        { laneKey: "channel:lane-a", receivedAt: 10 },
      );
      const failedClaim = await queue.claim("queued-cancelled", { ownerId: "failed-owner" });
      expect(failedClaim).not.toBeNull();
      if (!failedClaim) {
        return;
      }
      await queue.release(failedClaim, {
        lastError: "previous genuine failure",
        releasedAt: 20,
      });
      const before = (await queue.listPending())[0];
      const params = createDiscordHandlerParams();
      const processDiscordMessage = vi.fn(async () => {});
      const messageRunQueue = createDiscordMessageRunQueue({
        runtime: params.runtime,
        testing: { processDiscordMessage: processDiscordMessage as never },
      });
      const skipped = createDeferred<void>();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: params.runtime,
        queue,
        dispatch: async (_event, lifecycle) => {
          const ingress = fanInChannelIngressLifecycles([lifecycle]);
          messageRunQueue.enqueue(
            buildDiscordInboundJob(await createBaseDiscordMessageContext(), {
              ingressSettlement: ingress,
            }),
          );
          await messageRunQueue.deactivate();
          skipped.resolve();
          return { kind: "deferred" };
        },
      });
      monitor.start();
      try {
        await skipped.promise;
        await monitor.stop();
        expect(processDiscordMessage).not.toHaveBeenCalled();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "queued-cancelled",
            attempts: before?.attempts,
            lastAttemptAt: before?.lastAttemptAt,
            lastError: before?.lastError,
          }),
        ]);
      } finally {
        await monitor.stop();
        await messageRunQueue.deactivate();
      }

      const recovered = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const replacement = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: params.runtime,
        queue,
        dispatch: recovered,
      });
      replacement.start();
      try {
        await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1));
        await expect(
          queue.enqueue("queued-cancelled", {} as DiscordIngressPayload),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await replacement.stop();
      }
    });
  });

  it("does not abort concurrent runs with a Discord-owned channel timeout", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();

      const firstRun = createDeferred<void>();
      const secondRun = createDeferred<void>();
      const capturedAbortSignals: Array<AbortSignal | undefined> = [];
      processDiscordMessageMock.mockImplementationOnce(
        async (ctx: { abortSignal?: AbortSignal }) => {
          capturedAbortSignals.push(ctx.abortSignal);
          await firstRun.promise;
        },
      );
      processDiscordMessageMock.mockImplementationOnce(
        async (ctx: { abortSignal?: AbortSignal }) => {
          capturedAbortSignals.push(ctx.abortSignal);
          await secondRun.promise;
        },
      );
      installDefaultDiscordPreflight();
      const params = createDiscordHandlerParams();
      const handler = createDiscordMessageHandler(params);

      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();
      await expect(
        handler(createMessageData("m-2") as never, {} as never),
      ).resolves.toBeUndefined();
      await flushQueueWork();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushQueueWork();

      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(capturedAbortSignals).toEqual([undefined, undefined]);
      const runtimeError = params.runtime.error as unknown as MockCallSource;
      expect(
        mockCalls(runtimeError).some(([message]) => String(message).includes("timed out")),
      ).toBe(false);

      firstRun.resolve();
      secondRun.resolve();
      await Promise.all([firstRun.promise, secondRun.promise]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes run activity while active runs are in progress", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const runInFlight = createDeferred<void>();
    processDiscordMessageMock.mockImplementation(async () => {
      await runInFlight.promise;
    });
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    let heartbeatTick: () => void = () => {};
    let capturedHeartbeat = false;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          heartbeatTick = () => {
            callback();
          };
          capturedHeartbeat = true;
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      const setStatus = vi.fn();
      const handler = createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));
      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();

      await flushQueueWork();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

      expect(capturedHeartbeat).toBe(true);
      const busyCallsBefore = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;

      heartbeatTick();

      const busyCallsAfter = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;
      expect(busyCallsAfter).toBeGreaterThan(busyCallsBefore);

      runInFlight.resolve();
      await runInFlight.promise;

      await flushQueueWork();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("stops status publishing after lifecycle abort", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const abortController = new AbortController();
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status, abortSignal: abortController.signal }),
        );
        return { handler, stop: () => abortController.abort() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("stops status publishing after handler deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status }),
        );
        return { handler, stop: () => handler.deactivate() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("removes lifecycle abort listeners after handler deactivation", async () => {
    const abortController = new AbortController();
    const initialListenerCount = getEventListeners(abortController.signal, "abort").length;
    const handler = createDiscordMessageHandler(
      createDiscordHandlerParams({ abortSignal: abortController.signal }),
    );

    expect(getEventListeners(abortController.signal, "abort")).toHaveLength(
      initialListenerCount + 2,
    );

    await handler.deactivate();

    expect(getEventListeners(abortController.signal, "abort")).toHaveLength(initialListenerCount);
  });

  it("preserves non-debounced message ordering by awaiting debouncer enqueue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstPreflight = createDeferred<void>();
    const processedMessageIds: string[] = [];

    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string; message?: { id?: string } } }) => {
        const messageId = params.data.message?.id ?? "unknown";
        if (messageId === "m-1") {
          await firstPreflight.promise;
        }
        return {
          ...createPreflightContext(params.data.channel_id),
          messageId,
        };
      },
    );

    processDiscordMessageMock.mockImplementation(async (ctx: { messageId?: string }) => {
      processedMessageIds.push(ctx.messageId ?? "unknown");
    });

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    const sequentialDispatch = (async () => {
      await handler(createMessageData("m-1") as never, {} as never);
      await handler(createMessageData("m-2") as never, {} as never);
    })();

    await flushQueueWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);

    firstPreflight.resolve();
    await sequentialDispatch;

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(processedMessageIds).toEqual(["m-1", "m-2"]);
  });

  it("reports a concurrent run failure without leaving busy state stuck", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred<void>();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
        throw new Error("simulated run failure");
      })
      .mockImplementationOnce(async () => undefined);
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const setStatus = vi.fn();
    const handler = createHandlerWithDefaultPreflight({ setStatus });

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    firstRun.resolve();
    await firstRun.promise.catch(() => undefined);

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expectStatusPatch(setStatus, { activeRuns: 0, busy: false });
  });
});
