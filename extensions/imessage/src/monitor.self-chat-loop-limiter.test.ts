// Imessage tests cover monitor self-chat loop rate limiter plugin behavior.
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const dispatchReplyWithBufferedBlockDispatcherMock = vi.hoisted(() =>
  vi.fn<typeof dispatchReplyWithBufferedBlockDispatcher>(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    recordInboundSession: vi.fn(),
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn((opts) => ({
      debouncer: {
        enqueue: async (entry: unknown) =>
          await opts.onFlush([entry], createTestInboundDebounceFlush).completion,
        flushKey: async () => {},
        cancelKey: () => false,
        drain: async () => {},
      },
    })),
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

type RunChannelInboundEventParams = Parameters<typeof channelInbound.runChannelInboundEvent>[0];

async function runChannelInboundEventForSelfChatTest(params: RunChannelInboundEventParams) {
  const input = await params.adapter.ingest(params.raw);
  if (!input) {
    return { admission: { kind: "drop" as const, reason: "ingest-null" }, dispatched: false };
  }
  const eventClass = (await params.adapter.classify?.(input)) ?? {
    kind: "message" as const,
    canStartAgentTurn: true,
  };
  if (!eventClass.canStartAgentTurn) {
    return {
      admission: { kind: "handled" as const, reason: `event:${eventClass.kind}` },
      dispatched: false,
    };
  }
  const rawPreflight = await params.adapter.preflight?.(input, eventClass);
  const preflight =
    rawPreflight && "kind" in rawPreflight ? { admission: rawPreflight } : rawPreflight;
  const preflightFacts = preflight ?? {};
  const preflightAdmission = preflightFacts.admission;
  if (
    preflightAdmission &&
    preflightAdmission.kind !== "dispatch" &&
    preflightAdmission.kind !== "observeOnly"
  ) {
    return { admission: preflightAdmission, dispatched: false };
  }
  const turn = await params.adapter.resolveTurn(input, eventClass, preflightFacts);
  if (!("route" in turn) || !("delivery" in turn)) {
    throw new Error("expected assembled iMessage channel turn plan");
  }
  const admission = turn.admission ?? preflightAdmission ?? { kind: "dispatch" as const };
  const result = {
    admission,
    dispatched: true as const,
    ctxPayload: turn.ctxPayload,
    routeSessionKey: turn.route.sessionKey,
    dispatchResult: await dispatchReplyWithBufferedBlockDispatcherMock({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      dispatcherOptions: {
        ...turn.dispatcherOptions,
        deliver: turn.delivery.deliver,
        onError: turn.delivery.onError,
      },
      toolsAllow: turn.toolsAllow,
      replyOptions: turn.replyOptions,
      replyResolver: turn.replyResolver,
    }),
  };
  await params.adapter.onFinalize?.(result);
  return result;
}

const SELF_HANDLE = "+15551234567";
const USER_MESSAGE_COUNT = 8;

describe("monitorIMessageProvider self-chat loop rate limiter", () => {
  beforeEach(() => {
    vi.spyOn(channelInbound, "runChannelInboundEvent").mockImplementation(
      runChannelInboundEventForSelfChatTest as typeof channelInbound.runChannelInboundEvent,
    );
    installIMessageStateRuntimeForTest();
    createIMessageRpcClientMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps delivering self-chat messages past the loop limit", async () => {
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    let onNotification:
      | ((message: { method: string; params: unknown }) => void | Promise<void>)
      | undefined;

    const selfChatRow = (params: {
      id: number;
      guid: string;
      text: string;
      createdAt: string;
      fromMe: boolean;
    }) => ({
      id: params.id,
      guid: params.guid,
      chat_id: 42,
      sender: SELF_HANDLE,
      chat_identifier: SELF_HANDLE,
      destination_caller_id: SELF_HANDLE,
      is_from_me: params.fromMe,
      is_group: false,
      text: params.text,
      created_at: params.createdAt,
      attachments: [],
    });

    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        for (let index = 1; index <= USER_MESSAGE_COUNT; index += 1) {
          const text = `user message ${index}`;
          const createdAt = new Date(Date.now() + index).toISOString();
          for (const fromMe of [true, false]) {
            await onNotification?.({
              method: "message",
              params: {
                message: selfChatRow({
                  id: index * 2 + (fromMe ? 0 : 1),
                  guid: `${fromMe ? "sent" : "recv"}-${index}`,
                  text,
                  createdAt,
                  fromMe,
                }),
              },
            });
            await Promise.resolve();
            await Promise.resolve();
          }
        }
      }),
      stop: vi.fn(async () => {}),
    };

    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupPolicy: "open",
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 1_500);
    });

    const delivered = dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.map(
      (call) => (call[0].ctx as { BodyForAgent?: string }).BodyForAgent,
    );
    expect(delivered).toEqual(
      Array.from({ length: USER_MESSAGE_COUNT }, (_, index) => `user message ${index + 1}`),
    );
    const logs = runtime.log.mock.calls.map(([message]) => String(message));
    expect(logs.filter((message) => message.includes("rate limiter tripped"))).toEqual([]);
  });
});
