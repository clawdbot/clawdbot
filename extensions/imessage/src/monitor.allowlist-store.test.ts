// Imessage tests cover monitor pairing-store admission failures.
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
const upsertChannelPairingRequestMock = vi.hoisted(() => vi.fn());
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
    upsertChannelPairingRequest: upsertChannelPairingRequestMock,
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

async function runChannelInboundEventForAllowlistStoreTest(params: RunChannelInboundEventParams) {
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

describe("iMessage inbound pairing-store read failures", () => {
  beforeEach(() => {
    vi.spyOn(channelInbound, "runChannelInboundEvent").mockImplementation(
      runChannelInboundEventForAllowlistStoreTest as typeof channelInbound.runChannelInboundEvent,
    );
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertChannelPairingRequestMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails inbound when the pairing store cannot be read instead of treating the sender as unpaired", async () => {
    readChannelAllowFromStoreMock.mockRejectedValueOnce(new Error("pairing db locked"));
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const sendClient = {
      request: vi.fn(async () => ({ guid: "pairing-reply-guid" })),
      stop: vi.fn(async () => {}),
    };
    let onNotification:
      | ((message: { method: string; params: unknown }) => void | Promise<void>)
      | undefined;
    const watchClient = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        await onNotification?.({
          method: "message",
          params: {
            message: {
              id: 1,
              guid: "pairing-store-read-fail-guid-1",
              chat_id: 123,
              chat_identifier: "+15550001111",
              sender: "+15550001111",
              is_from_me: false,
              is_group: false,
              text: "hello from a paired sender",
              created_at: new Date().toISOString(),
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (params?.onNotification) {
        onNotification = params.onNotification;
        return watchClient as never;
      }
      return sendClient as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            dmPolicy: "pairing",
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime,
    });

    await vi.waitFor(() => expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1));
    expect(readChannelAllowFromStoreMock).toHaveBeenCalledWith(
      "imessage",
      expect.anything(),
      expect.any(String),
    );
    expect(upsertChannelPairingRequestMock).not.toHaveBeenCalled();
    expect(sendClient.request).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
    expect(runtime.error.mock.calls.flat().map(String).join("\n")).toMatch(
      /pairing-store read failed|inbound dispatch failed|pairing db locked/i,
    );
  });
});
