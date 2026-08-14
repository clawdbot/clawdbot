// Nostr tests cover channel.lifecycle plugin behavior.
import {
  createStartAccountContext,
  createPluginRuntimeMock,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveNostrBuses, startNostrGatewayAccount } from "./gateway.js";
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
      startAccount: startNostrGatewayAccount,
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
      startAccount: startNostrGatewayAccount,
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

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const bus = createMockBus();
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);
    const abort = new AbortController();
    abort.abort();

    await startNostrGatewayAccount(
      createStartAccountContext({
        account: buildResolvedNostrAccount(),
        abortSignal: abort.signal,
      }),
    );

    expect(mocks.startNostrBus).toHaveBeenCalledOnce();
    expect(bus.close).toHaveBeenCalledOnce();
  });

  it("describes configured relays without claiming they are already connected", async () => {
    const bus = createMockBus();
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);
    const abort = new AbortController();
    const account = buildResolvedNostrAccount({ relays: ["wss://relay.example.com"] });
    const context = createStartAccountContext({ account, abortSignal: abort.signal });

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
    const context = createStartAccountContext({
      account: buildResolvedNostrAccount(),
      abortSignal: abort.signal,
      statusPatchSink: (patch) => statusEvents.push(patch as Record<string, unknown>),
    });

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
