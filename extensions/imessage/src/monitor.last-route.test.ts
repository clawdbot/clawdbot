import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const recordInboundSessionMock = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(
    async (_params: { ctx: MsgContext }) =>
      ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }) as const,
  ),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    recordInboundSession: recordInboundSessionMock,
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn((opts) => ({
      debouncer: {
        enqueue: async (entry: unknown) => await opts.onFlush([entry]),
      },
    })),
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

describe("iMessage monitor last-route updates", () => {
  beforeEach(() => {
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    recordInboundSessionMock.mockClear();
    dispatchInboundMessageMock.mockClear();
  });

  it("keeps per-channel-peer direct-message last-route writes on the isolated session", async () => {
    const runtimeErrorMock = vi.fn();
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 1,
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "hello from imessage",
              is_group: false,
              date: 1_714_000_000_000,
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { dmScope: "per-channel-peer", mainKey: "main" },
      } as never,
      runtime: { error: runtimeErrorMock, exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1);
    });
    expect(runtimeErrorMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    });
    const recordParams = recordInboundSessionMock.mock.calls.at(0)?.[0] as
      | {
          sessionKey?: string;
          updateLastRoute?: {
            channel?: string;
            mainDmOwnerPin?: unknown;
            sessionKey?: string;
            to?: string;
          };
        }
      | undefined;
    expect(recordParams?.sessionKey).toBe("agent:main:imessage:direct:+15550001111");
    expect(recordParams?.updateLastRoute?.sessionKey).toBe(recordParams?.sessionKey);
    expect(recordParams?.updateLastRoute?.sessionKey).not.toBe("agent:main:main");
    expect(recordParams?.updateLastRoute?.channel).toBe("imessage");
    expect(recordParams?.updateLastRoute?.to).toBe("+15550001111");
    expect(recordParams?.updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });
});
