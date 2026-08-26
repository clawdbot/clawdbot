// Telegram ingress coalescing regression: durable queue → core drain → grammY → inbound buffer.
// Both Telegram inbound buffers (album, forward-burst debounce) defer their spooled
// participant the same way, so both depend on deferredLaneOccupancy="release" to admit
// later same-lane members. Cover them together — a lane regression breaks both at once.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import type { TelegramTransport } from "./fetch.js";
import type { TelegramRuntime } from "./runtime.types.js";

const downstreamTurns = vi.hoisted(() =>
  vi.fn(async (_ctx: MsgContext) => ({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  })),
);

vi.mock("./fetch.js", () => ({
  resolveTelegramApiBase: (apiRoot?: string) => apiRoot ?? "https://api.telegram.org",
  resolveTelegramFetch: (proxyFetch?: typeof fetch) => proxyFetch ?? globalThis.fetch,
  resolveTelegramTransport: (proxyFetch?: typeof fetch) => {
    const fetchImpl = proxyFetch ?? globalThis.fetch;
    return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
  },
  shouldRetryTelegramTransportFallback: () => false,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) =>
      await runTelegramChannelInboundEventWithHarness(actual, params, async (dispatchParams) => {
        return await downstreamTurns(dispatchParams.ctx);
      }),
  };
});

vi.mock("./telegram-media.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-media.runtime.js")>();
  return {
    ...actual,
    saveRemoteMedia: async (params: { filePathHint?: string }) => ({
      id: params.filePathHint ?? "photo",
      path: `/tmp/${path.basename(params.filePathHint ?? "photo.jpg")}`,
      size: 4,
      contentType: "image/jpeg",
    }),
  };
});

vi.mock("./bot-handlers.agent.runtime.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
}));

vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog: vi.fn(() => undefined),
  loadPreparedModelCatalog: vi.fn(async () => []),
  modelSupportsVision: vi.fn(() => false),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

const { createTelegramBot } = await import("./bot.js");
const { resetInboundDedupe } = await import("openclaw/plugin-sdk/reply-runtime");
const { createTelegramTransportIngressMonitor } =
  await import("./telegram-ingress-drain-factory.js");
const { setTelegramRuntime } = await import("./runtime.js");
const { resetTelegramAccountThrottlersForTest } = await import("./runtime.test-support.js");
const { openTelegramIngressQueue, telegramQueueEventId } =
  await import("./telegram-ingress-spool.js");
const { writeTelegramSpooledUpdate } = await import("./telegram-ingress-spool.test-support.js");

const cfg = {
  channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
} as OpenClawConfig;

function photoUpdate(params: { updateId: number; messageId: number; caption?: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      media_group_id: "album-115325",
      ...(params.caption ? { caption: params.caption } : {}),
      photo: [
        {
          file_id: `photo-${params.messageId}`,
          file_unique_id: `unique-${params.messageId}`,
          width: 100,
          height: 100,
          file_size: 4,
        },
      ],
    },
  };
}

function forwardedTextUpdate(params: { updateId: number; messageId: number; text: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      // forward_origin puts the entry on the forward debounce lane (80ms window).
      forward_origin: {
        type: "user" as const,
        date: 1_736_300_000,
        sender_user: { id: 555, is_bot: false, first_name: "Origin" },
      },
      text: params.text,
    },
  };
}

function createBotApiTransport() {
  let getFileCall = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (url.includes("/getFile")) {
      getFileCall += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_id: `photo-${getFileCall}`,
            file_unique_id: `unique-${getFileCall}`,
            file_size: 4,
            file_path: `photos/photo-${getFileCall}.jpg`,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
}

function createTelegramDeps(stateDir: string): TelegramBotDeps {
  return {
    getRuntimeConfig: () => cfg,
    resolveStorePath: (storePath?: string) => storePath ?? path.join(stateDir, "sessions.json"),
    readChannelAllowFromStore: async () => [],
    upsertChannelPairingRequest: async () => ({ code: "PAIRCODE", created: true }),
    enqueueSystemEvent: () => false,
    dispatchReplyWithBufferedBlockDispatcher: async () => ({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    }),
    buildModelsProviderData: async () => ({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: { provider: "openai", model: "gpt-test" },
      modelNames: new Map<string, string>(),
    }),
    listSkillCommandsForAgents: () => [],
    wasSentByBot: () => false,
  } as TelegramBotDeps;
}

/** Both members must land in one turn; a second turn is the split this file guards. */
async function awaitSingleDownstreamTurn(): Promise<MsgContext & Record<string, unknown>> {
  await vi.waitFor(
    () => {
      expect(downstreamTurns).toHaveBeenCalledTimes(1);
    },
    { timeout: 5_000, interval: 5 },
  );
  return downstreamTurns.mock.calls[0]?.[0] as MsgContext & Record<string, unknown>;
}

async function assertSpoolTombstoned(params: { spoolDir: string; updateIds: number[] }) {
  const queue = openTelegramIngressQueue(params.spoolDir);
  await vi.waitFor(async () => {
    expect(await queue.listClaims()).toEqual([]);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
  });
  // Every member tombstones independently, so a replayed update cannot re-enter.
  for (const updateId of params.updateIds) {
    await expect(queue.enqueue(telegramQueueEventId(updateId), {} as never)).resolves.toMatchObject(
      { kind: "completed" },
    );
  }
}

async function assertAlbumTurnAndTombstones(params: { spoolDir: string; updateIds: number[] }) {
  const turn = await awaitSingleDownstreamTurn();
  expect(turn.Body).toContain("Two photo album");
  expect(turn.media).toMatchObject([
    { path: "/tmp/photo-1.jpg", kind: "image" },
    { path: "/tmp/photo-2.jpg", kind: "image" },
  ]);
  await assertSpoolTombstoned(params);
}

describe("Telegram durable ingress coalescing", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let spoolDir: string;
  let activeResources: Array<{
    monitor: ReturnType<typeof createTelegramTransportIngressMonitor>;
    telegramTransport: TelegramTransport;
    abortController: AbortController;
  }>;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-album-ingress-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    spoolDir = path.join(stateDir, "telegram", "ingress-spool-default");
    activeResources = [];
    downstreamTurns
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    resetInboundDedupe();
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetTelegramAccountThrottlersForTest();
    setTelegramRuntime({
      state: {
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
        ) => createChannelIngressQueueForTests({ ...options, channelId: "telegram" }),
        // Command-menu locale ledger reads the keyed store during hydration;
        // an absent store degrades with a warning that breaks watchdog asserts.
        openKeyedStore: ((options) =>
          createPluginStateKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
  });

  afterEach(async () => {
    await Promise.all(
      activeResources.map(async ({ monitor, telegramTransport, abortController }) => {
        abortController.abort(new Error("test cleanup"));
        await monitor.stop();
        await telegramTransport.close();
      }),
    );
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function createMonitor(
    options: {
      telegramTransport?: TelegramTransport;
      adoptionStallTimeoutMs?: number;
      onRuntimeError?: (error: unknown) => void;
    } = {},
  ) {
    const telegramTransport = options.telegramTransport ?? createBotApiTransport();
    const abortController = new AbortController();
    const bot = createTelegramBot({
      token: "tok",
      botInfo: telegramBotInfoForTest,
      config: cfg,
      telegramDeps: createTelegramDeps(stateDir),
      telegramTransport,
      fetchAbortSignal: abortController.signal,
      mediaAbortSignal: abortController.signal,
      testTimings: { mediaGroupFlushMs: 40, textFragmentGapMs: 20 },
      runtime: {
        log: () => {},
        error:
          options.onRuntimeError ??
          ((error) => {
            throw error instanceof Error ? error : new Error(String(error));
          }),
        getRuntimeConfig: () => cfg,
        exit: () => {
          throw new Error("unexpected runtime exit");
        },
      } as RuntimeEnv,
    });
    const monitor = createTelegramTransportIngressMonitor({
      spoolDir,
      bot,
      cfg,
      accountId: "default",
      botInfo: telegramBotInfoForTest,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      pollIntervalMs: 10,
    });
    const resources = { monitor, telegramTransport, abortController };
    activeResources.push(resources);
    return resources;
  }

  it("coalesces album members admitted a few milliseconds apart", async () => {
    const { monitor, telegramTransport } = await createMonitor();
    const first = photoUpdate({ updateId: 101, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 102, messageId: 2 });
    monitor.start();

    await monitor.admit(first);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await monitor.admit(second);
    await assertAlbumTurnAndTombstones({ spoolDir, updateIds: [101, 102] });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("coalesces an album replayed from a durable restart backlog", async () => {
    const first = photoUpdate({ updateId: 201, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 202, messageId: 2 });
    await writeTelegramSpooledUpdate({ spoolDir, update: first });
    await writeTelegramSpooledUpdate({ spoolDir, update: second });
    const { monitor, telegramTransport } = await createMonitor();

    monitor.start();
    await assertAlbumTurnAndTombstones({ spoolDir, updateIds: [201, 202] });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("coalesces a forwarded burst admitted a few milliseconds apart", async () => {
    const { monitor, telegramTransport } = await createMonitor();
    monitor.start();

    await monitor.admit(forwardedTextUpdate({ updateId: 301, messageId: 1, text: "First note" }));
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await monitor.admit(forwardedTextUpdate({ updateId: 302, messageId: 2, text: "Second note" }));

    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.Body).toContain("Second note");
    await assertSpoolTombstoned({ spoolDir, updateIds: [301, 302] });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("dispatches sustained forwarded messages before their ingress stream falls quiet", async () => {
    const { monitor, telegramTransport } = await createMonitor();
    const messageCount = 24;
    const updateIds = Array.from({ length: messageCount }, (_, index) => 501 + index);
    monitor.start();

    for (let index = 0; index < messageCount; index += 1) {
      await monitor.admit(
        forwardedTextUpdate({
          updateId: 501 + index,
          messageId: index + 1,
          text: `sustained-forward-${String(index).padStart(2, "0")}`,
        }),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }

    expect(downstreamTurns.mock.calls.length).toBeGreaterThan(0);

    await vi.waitFor(
      () => {
        const deliveredMessageIds = downstreamTurns.mock.calls.flatMap(([context]) => {
          const turn = context as MsgContext;
          return Array.from(
            (turn.BodyForAgent ?? turn.Body ?? "").matchAll(/sustained-forward-(\d{2})/g),
            (match) => match[1],
          );
        });
        expect(deliveredMessageIds).toEqual(
          Array.from({ length: messageCount }, (_, index) => String(index).padStart(2, "0")),
        );
      },
      { timeout: 5_000, interval: 5 },
    );
    await assertSpoolTombstoned({ spoolDir, updateIds });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("coalesces a forwarded burst replayed from a durable restart backlog", async () => {
    await writeTelegramSpooledUpdate({
      spoolDir,
      update: forwardedTextUpdate({ updateId: 401, messageId: 1, text: "First note" }),
    });
    await writeTelegramSpooledUpdate({
      spoolDir,
      update: forwardedTextUpdate({ updateId: 402, messageId: 2, text: "Second note" }),
    });
    const { monitor, telegramTransport } = await createMonitor();

    monitor.start();
    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.Body).toContain("Second note");
    await assertSpoolTombstoned({ spoolDir, updateIds: [401, 402] });

    await monitor.stop();
    await telegramTransport.close();
  });

  it("releases a stale forwarded claim once when custom debounce dispatch fails", async () => {
    const update = forwardedTextUpdate({
      updateId: 701,
      messageId: 1,
      text: "recovered forward",
    });
    const eventId = telegramQueueEventId(update.update_id);
    const sessionError = new Error("Session changed while starting work. Retry.");
    await writeTelegramSpooledUpdate({ spoolDir, update });
    const queue = openTelegramIngressQueue(spoolDir);
    expect(await queue.claim(eventId, { ownerId: "999:1:dead-owner" })).not.toBeNull();
    downstreamTurns.mockRejectedValueOnce(sessionError);
    const runtimeError = vi.fn();
    const { monitor, telegramTransport } = await createMonitor({
      adoptionStallTimeoutMs: 5_000,
      onRuntimeError: runtimeError,
    });

    monitor.start();
    await vi.waitFor(
      async () => {
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 2, lastError: sessionError.message },
        ]);
      },
      { timeout: 2_000, interval: 5 },
    );
    expect(downstreamTurns).toHaveBeenCalledOnce();
    expect(runtimeError).toHaveBeenCalledOnce();

    await monitor.stop();
    await telegramTransport.close();
  });
});
