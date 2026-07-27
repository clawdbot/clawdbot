// Imessage tests cover approval poll durable-ingress ownership.
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const maybeResolveIMessageApprovalPollVoteMock = vi.hoisted(() => vi.fn());
const ingressLifecycleMocks = vi.hoisted(() => ({
  onAdopted: vi.fn(async () => {}),
  onDeferred: vi.fn(),
  onAdoptionFinalizing: vi.fn(),
  onAbandoned: vi.fn(async () => {}),
}));
const ingressHarness = vi.hoisted(() => ({
  done: Promise.resolve(),
  resolveDone: () => {},
}));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn(
      (opts: { onFlush: (entries: unknown[]) => Promise<void> }) => ({
        debouncer: {
          enqueue: async (entry: unknown) => {
            await opts.onFlush([entry]);
          },
        },
      }),
    ),
  };
});

vi.mock("./approval-polls.js", () => ({
  maybeResolveIMessageApprovalPollVote: maybeResolveIMessageApprovalPollVoteMock,
}));

vi.mock("./approval-reaction-poller.js", () => ({
  pollPendingIMessageApprovalReactions: vi.fn(async () => {}),
}));

vi.mock("./approval-reactions.js", () => ({
  maybeResolveIMessageApprovalReaction: vi.fn(async () => false),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

vi.mock("./monitor/ingress.js", () => ({
  createIMessageDurableIngress: vi.fn(
    (opts: {
      dispatch: (
        message: unknown,
        lifecycle: unknown,
        receivedAt: number,
        provenance: object,
      ) => Promise<unknown>;
    }) => ({
      receive: async (raw: { message: unknown }) => {
        try {
          await opts.dispatch(
            raw.message,
            {
              abortSignal: new AbortController().signal,
              ...ingressLifecycleMocks,
            },
            Date.now(),
            {},
          );
        } finally {
          ingressHarness.resolveDone();
        }
      },
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    }),
  ),
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

describe("iMessage approval poll durable ingress", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    maybeResolveIMessageApprovalPollVoteMock.mockReset();
    for (const mock of Object.values(ingressLifecycleMocks)) {
      mock.mockClear();
    }
    ingressHarness.done = new Promise<void>((resolve) => {
      ingressHarness.resolveDone = () => resolve();
    });
  });

  function arrangeNotification() {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {
          onNotification?.({
            method: "message",
            params: {
              message: {
                id: 42,
                guid: "approval-poll-vote-guid",
                chat_id: 7,
                chat_guid: "iMessage;-;redacted-peer",
                chat_identifier: "redacted-peer",
                sender: "redacted-peer",
                is_from_me: false,
                is_group: false,
                created_at: new Date().toISOString(),
                poll: {
                  kind: "vote",
                  original_guid: "approval-poll-guid",
                  vote: { option_id: "approve-once" },
                },
              },
            },
          });
          await ingressHarness.done;
        }),
        stop: vi.fn(async () => {}),
      } as never;
    });
  }

  it("completes a handled approval vote instead of abandoning it for replay", async () => {
    arrangeNotification();
    maybeResolveIMessageApprovalPollVoteMock.mockResolvedValue(true);

    await monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: createRuntime() as never,
    });

    expect(ingressLifecycleMocks.onAdopted).toHaveBeenCalledTimes(1);
    expect(ingressLifecycleMocks.onAbandoned).not.toHaveBeenCalled();
  });

  it("abandons a claim when approval vote resolution fails transiently", async () => {
    arrangeNotification();
    maybeResolveIMessageApprovalPollVoteMock.mockRejectedValue(new Error("gateway unavailable"));
    const runtime = createRuntime();

    await monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    });

    expect(ingressLifecycleMocks.onAdopted).not.toHaveBeenCalled();
    expect(ingressLifecycleMocks.onAbandoned).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("imessage: inbound dispatch failed: Error: gateway unavailable"),
    );
  });
});
