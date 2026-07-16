// Signal tests cover ordered control delivery around active inbound work.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dispatchInboundMessageMock,
  recordInboundSessionMock,
  sendReadReceiptMock,
  sendTypingMock,
} = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
  sendReadReceiptMock: vi.fn(),
  sendTypingMock: vi.fn(),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    recordInboundSession: recordInboundSessionMock,
    readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
    upsertChannelPairingRequest: vi.fn(),
  };
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
  {
    createSignalPendingInboundRegistry,
    resolveSignalControlLaneKey,
    resolveSignalInboundDebounceKey,
  },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("./event-handler.control-lane.js"),
]);

type DispatchParams = { ctx: MsgContext };

const dispatchResult = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 1 },
};

function createHandler(debounceMs: number) {
  const dmPolicy = "allowlist";
  const allowFrom = ["+15550001111"];
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: {
        messages: { inbound: { debounceMs } },
        channels: { signal: { dmPolicy, allowFrom } },
      } as OpenClawConfig,
      dmPolicy,
      allowFrom,
      historyLimit: 0,
    }),
  );
}

function signalText(message: string, timestamp: number) {
  return createSignalReceiveEvent({
    timestamp,
    dataMessage: { message, attachments: [] },
  });
}

function signalGroupText(message: string, timestamp: number, sourceNumber: string) {
  return createSignalReceiveEvent({
    sourceNumber,
    sourceName: sourceNumber,
    timestamp,
    dataMessage: {
      message,
      attachments: [],
      groupInfo: { groupId: "group-1", groupName: "Test Group" },
    },
  });
}

function dispatchedCommandBody(index: number): string | undefined {
  const call = dispatchInboundMessageMock.mock.calls[index];
  if (!call) {
    throw new Error(`missing dispatch call ${index}`);
  }
  return (call[0] as DispatchParams).ctx.CommandBody;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("Signal active-run control lane", () => {
  beforeEach(() => {
    vi.useRealTimers();
    dispatchInboundMessageMock.mockReset().mockResolvedValue(dispatchResult);
    recordInboundSessionMock.mockReset().mockResolvedValue(undefined);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    sendTypingMock.mockReset().mockResolvedValue(true);
  });

  it.each([
    "stop",
    "/approve abc12345 allow-once",
    "/status",
    "/queue",
    "/QUEUE",
    "/steer keep going",
  ])("dispatches active-run-safe control %s while normal work is active", async (controlText) => {
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    dispatchInboundMessageMock.mockImplementationOnce(async () => {
      await activeGate;
      return dispatchResult;
    });
    const handler = createHandler(5);

    await handler(signalText("start a long task", 1));
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1));

    const controlHandled = handler(signalText(controlText, 2));
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2));
    expect(dispatchedCommandBody(1)).toBe(controlText);

    releaseActive();
    await controlHandled;
  });

  it("serializes repeated aborts on the control lane", async () => {
    let releaseFirstAbort!: () => void;
    const firstAbortGate = new Promise<void>((resolve) => {
      releaseFirstAbort = resolve;
    });
    dispatchInboundMessageMock.mockImplementationOnce(async () => {
      await firstAbortGate;
      return dispatchResult;
    });
    const handler = createHandler(0);

    const first = handler(signalText("stop", 1));
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1));
    const second = handler(signalText("halt", 2));
    await delay(20);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

    releaseFirstAbort();
    await Promise.all([first, second]);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchedCommandBody(1)).toBe("halt");
  });

  it.each(["one more detail", "/reset"])(
    "leaves zero-debounce turn %s to core session admission",
    async (followupText) => {
      let releaseActive!: () => void;
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        await activeGate;
        return dispatchResult;
      });
      const handler = createHandler(0);

      const active = handler(signalText("start a long task", 1));
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1));
      const followup = handler(signalText(followupText, 2));
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2));
      expect(dispatchedCommandBody(1)).toBe(followupText);

      releaseActive();
      await Promise.all([active, followup]);
    },
  );

  it("does not promote or cancel an unauthorized abort", () => {
    const entry = {
      senderName: "Alice",
      senderDisplay: "+15550001111",
      senderRecipient: "+15550001111",
      senderPeerId: "+15550001111",
      isGroup: false,
      bodyText: "stop",
      commandBody: "stop",
      commandAuthorized: false,
    };
    const cancelKey = vi.fn(() => true);
    const pendingInboundRegistry = createSignalPendingInboundRegistry("default");

    expect(resolveSignalInboundDebounceKey("default", entry)).toBe(
      "signal:default:+15550001111:+15550001111",
    );
    expect(resolveSignalControlLaneKey("default", entry)).toBeNull();
    pendingInboundRegistry.track(entry);
    pendingInboundRegistry.cancelPendingOnAbort(entry, cancelKey);
    expect(cancelKey).not.toHaveBeenCalled();
  });

  it("shares one group control lane without merging normal sender batches", () => {
    const entry = {
      senderName: "Alice",
      senderDisplay: "+15550001111",
      senderRecipient: "+15550001111",
      senderPeerId: "+15550001111",
      groupId: "group-1",
      isGroup: true,
      bodyText: "stop",
      commandBody: "stop",
      commandAuthorized: true,
    };
    const otherSender = { ...entry, senderPeerId: "+15550002222" };

    expect(resolveSignalControlLaneKey("default", entry)).toBe(
      resolveSignalControlLaneKey("default", otherSender),
    );
    expect(resolveSignalInboundDebounceKey("default", entry)).not.toBe(
      resolveSignalInboundDebounceKey("default", otherSender),
    );
  });

  it.each([
    "/reset",
    "/queue status",
    "/queue collect",
    "/queue interrupt",
    "/queue reset",
    "/queue debounce:2s",
    "/queue cap:5",
    "/queue drop:summarize",
  ])("keeps stateful command %s behind active conversation work", async (commandText) => {
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    dispatchInboundMessageMock.mockImplementationOnce(async () => {
      await activeGate;
      return dispatchResult;
    });
    const handler = createHandler(5);

    const active = handler(signalText("start a long task", 1));
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1));
    const statefulCommand = handler(signalText(commandText, 2));
    await delay(20);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

    releaseActive();
    await Promise.all([active, statefulCommand]);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchedCommandBody(1)).toBe(commandText);
  });

  it("cancels ordinary text still waiting in the debounce window", async () => {
    const handler = createHandler(50);

    await handler(signalText("queued work", 1));
    await handler(signalText("stop", 2));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchedCommandBody(0)).toBe("stop");

    await delay(75);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("cancels pending normal work from every sender in a group conversation", async () => {
    const handler = createHandler(50);

    await handler(signalGroupText("queued work", 1, "+15550001111"));
    await handler(signalGroupText("stop", 2, "+15550002222"));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchedCommandBody(0)).toBe("stop");

    await delay(75);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("cancels ordinary text released from debounce but still waiting on active work", async () => {
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    dispatchInboundMessageMock.mockImplementationOnce(async () => {
      await activeGate;
      return dispatchResult;
    });
    const handler = createHandler(5);

    await handler(signalText("start a long task", 1));
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1));
    await handler(signalText("queued followup", 2));
    await delay(20);

    await handler(signalText("stop", 3));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchedCommandBody(1)).toBe("stop");

    releaseActive();
    await delay(20);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
  });
});
