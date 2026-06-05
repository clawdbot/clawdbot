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
    close: vi.fn(),
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
});
