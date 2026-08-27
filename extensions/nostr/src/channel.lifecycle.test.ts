import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
// Nostr tests cover channel.lifecycle plugin behavior.
import {
  createStartAccountContext,
  createPluginRuntimeMock,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveNostrBuses, nostrOutboundAdapter, startNostrGatewayAccount } from "./gateway.js";
import { setNostrRuntime } from "./runtime.js";
import { buildResolvedNostrAccount } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  startNostrBus: mocks.startNostrBus,
}));

function createMockBus() {
  return {
    sendDm: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getMetrics: vi.fn(() => ({ counters: {} })),
    publishProfile: vi.fn(),
    getProfileState: vi.fn(async () => null),
  };
}

function bindChannelRuntime(
  context: Parameters<typeof startNostrGatewayAccount>[0],
): Parameters<typeof startNostrGatewayAccount>[0] {
  context.channelRuntime = {
    inbound: { buildContext: buildChannelInboundEventContext },
  } as never;
  return context;
}

const startAccountWithChannelRuntime: typeof startNostrGatewayAccount = async (context) => {
  await startNostrGatewayAccount(bindChannelRuntime(context));
};

describe("nostr gateway lifecycle", () => {
  beforeEach(() => {
    setNostrRuntime(createPluginRuntimeMock());
  });

  afterEach(() => {
    mocks.startNostrBus.mockReset();
  });

  it("keeps startAccount pending until abort, then closes the bus", async () => {
    const bus = createMockBus();
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);

    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: startAccountWithChannelRuntime,
      account: buildResolvedNostrAccount(),
    });

    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(mocks.startNostrBus),
      isSettled,
      abort,
      task,
      stop: bus.close,
    });
  });

  it("keeps the active bus registered while pending and removes it after abort", async () => {
    const bus = createMockBus();
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);

    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: startAccountWithChannelRuntime,
      account: buildResolvedNostrAccount(),
    });

    await vi.waitFor(() => {
      expect(getActiveNostrBuses().get("default")).toBe(bus);
    });
    expect(isSettled()).toBe(false);

    abort.abort();
    await task;

    expect(bus.close).toHaveBeenCalledOnce();
    expect(getActiveNostrBuses().has("default")).toBe(false);
  });

  it.each([
    { outcome: "resolves", closeFails: false },
    { outcome: "rejects", closeFails: true },
  ])("retires the active bus before shutdown $outcome", async ({ closeFails }) => {
    const bus = createMockBus();
    let finishClose!: () => void;
    let rejectClose!: (reason: Error) => void;
    bus.close.mockReturnValueOnce(
      new Promise<void>((resolve, reject) => {
        finishClose = resolve;
        rejectClose = reject;
      }),
    );
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);
    const abort = new AbortController();
    const context = bindChannelRuntime(
      createStartAccountContext({
        account: buildResolvedNostrAccount(),
        abortSignal: abort.signal,
      }),
    );
    const lifecycle = startNostrGatewayAccount(context);

    await vi.waitFor(() => expect(getActiveNostrBuses().get("default")).toBe(bus));
    abort.abort();
    await vi.waitFor(() => expect(bus.close).toHaveBeenCalledOnce());

    const activeBusWhileClosing = getActiveNostrBuses().get("default");
    const sendWhileClosing = await nostrOutboundAdapter
      .sendText({
        cfg: context.cfg,
        to: context.account.publicKey,
        text: "hello",
        accountId: context.account.accountId,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const sendsWhileClosing = bus.sendDm.mock.calls.length;
    expect(context.log?.info).not.toHaveBeenCalledWith("[default] Nostr provider stopped");

    if (closeFails) {
      const closeError = new Error("Nostr relay shutdown failed");
      rejectClose(closeError);
      await expect(lifecycle).rejects.toBe(closeError);
      expect(context.log?.info).not.toHaveBeenCalledWith("[default] Nostr provider stopped");
    } else {
      finishClose();
      await expect(lifecycle).resolves.toBeUndefined();
      expect(context.log?.info).toHaveBeenCalledWith("[default] Nostr provider stopped");
    }

    expect(activeBusWhileClosing).toBeUndefined();
    expect(sendWhileClosing).toEqual(new Error("Nostr bus not running for account default"));
    expect(sendsWhileClosing).toBe(0);
    expect(getActiveNostrBuses().has("default")).toBe(false);

    if (closeFails) {
      await expect(
        nostrOutboundAdapter.sendText({
          cfg: context.cfg,
          to: context.account.publicKey,
          text: "hello again",
          accountId: context.account.accountId,
        }),
      ).rejects.toThrow("Nostr bus not running for account default");
      expect(bus.sendDm).not.toHaveBeenCalled();
    }
  });

  it("does not retire a replacement bus while the previous generation closes", async () => {
    const firstBus = createMockBus();
    const replacementBus = createMockBus();
    let finishFirstClose!: () => void;
    firstBus.close.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishFirstClose = resolve;
      }),
    );
    mocks.startNostrBus
      .mockResolvedValueOnce(firstBus as never)
      .mockResolvedValueOnce(replacementBus as never);
    const firstAbort = new AbortController();
    const firstLifecycle = startNostrGatewayAccount(
      bindChannelRuntime(
        createStartAccountContext({
          account: buildResolvedNostrAccount(),
          abortSignal: firstAbort.signal,
        }),
      ),
    );
    let replacementAbort: AbortController | undefined;
    let replacementLifecycle: typeof firstLifecycle | undefined;

    try {
      await vi.waitFor(() => expect(getActiveNostrBuses().get("default")).toBe(firstBus));
      replacementAbort = new AbortController();
      replacementLifecycle = startNostrGatewayAccount(
        bindChannelRuntime(
          createStartAccountContext({
            account: buildResolvedNostrAccount(),
            abortSignal: replacementAbort.signal,
          }),
        ),
      );
      await vi.waitFor(() => expect(getActiveNostrBuses().get("default")).toBe(replacementBus));

      firstAbort.abort();
      await vi.waitFor(() => expect(firstBus.close).toHaveBeenCalledOnce());
      expect(getActiveNostrBuses().get("default")).toBe(replacementBus);

      finishFirstClose();
      await expect(firstLifecycle).resolves.toBeUndefined();
      expect(getActiveNostrBuses().get("default")).toBe(replacementBus);

      replacementAbort.abort();
      await expect(replacementLifecycle).resolves.toBeUndefined();
      expect(getActiveNostrBuses().has("default")).toBe(false);
    } finally {
      firstAbort.abort();
      finishFirstClose();
      await firstLifecycle.catch(() => undefined);
      replacementAbort?.abort();
      await replacementLifecycle?.catch(() => undefined);
    }
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const bus = createMockBus();
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);
    const abort = new AbortController();
    abort.abort();

    await startNostrGatewayAccount(
      bindChannelRuntime(
        createStartAccountContext({
          account: buildResolvedNostrAccount(),
          abortSignal: abort.signal,
        }),
      ),
    );

    expect(mocks.startNostrBus).toHaveBeenCalledOnce();
    expect(bus.close).toHaveBeenCalledOnce();
  });

  it("describes configured relays without claiming they are already connected", async () => {
    const bus = createMockBus();
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);
    const abort = new AbortController();
    const account = buildResolvedNostrAccount({ relays: ["wss://relay.example.com"] });
    const context = bindChannelRuntime(
      createStartAccountContext({ account, abortSignal: abort.signal }),
    );

    const task = startNostrGatewayAccount(context);
    await vi.waitFor(() => expect(mocks.startNostrBus).toHaveBeenCalledOnce());

    expect(context.log?.info).toHaveBeenCalledWith(
      "[default] Nostr provider started with 1 configured relay(s)",
    );

    abort.abort();
    await task;
  });

  it("publishes ready with one relay and recovering only after the last relay disconnects", async () => {
    const bus = createMockBus();
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);
    const abort = new AbortController();
    const statusEvents: Array<Record<string, unknown>> = [];
    const context = bindChannelRuntime(
      createStartAccountContext({
        account: buildResolvedNostrAccount(),
        abortSignal: abort.signal,
        statusPatchSink: (patch) => statusEvents.push(patch as Record<string, unknown>),
      }),
    );

    const task = startNostrGatewayAccount(context);
    await vi.waitFor(() => expect(mocks.startNostrBus).toHaveBeenCalledOnce());
    const options = mocks.startNostrBus.mock.calls[0]?.[0] as
      | { onConnect?: (relay: string) => void; onDisconnect?: (relay: string) => void }
      | undefined;
    expect(statusEvents[0]).toMatchObject({ lifecycle: "starting" });

    options?.onConnect?.("wss://relay-one.example/");
    expect(statusEvents.at(-1)).toMatchObject({
      running: true,
      lifecycle: "ready",
      connected: true,
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    options?.onConnect?.("wss://relay-two.example/");
    const afterTwoConnected = statusEvents.length;
    options?.onDisconnect?.("wss://relay-one.example");
    expect(statusEvents).toHaveLength(afterTwoConnected);

    options?.onDisconnect?.("wss://relay-two.example");
    expect(statusEvents.at(-1)).toMatchObject({ lifecycle: "recovering", connected: false });

    abort.abort();
    await task;
  });
});
