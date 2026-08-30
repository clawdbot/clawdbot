import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import {
  createChannelParticipationCoordinator,
  type ChannelParticipationCandidate,
} from "./participation.js";

const candidate = (accountId: string): ChannelParticipationCandidate => ({
  accountId,
  agentId: accountId,
  participantId: `@${accountId}:example.org`,
});
const source = {
  eventKey: JSON.stringify(["example.org", "room", "$event"]),
  conversationId: "room",
  source: "native event",
  message: "Which language should we use?",
};

function setup(handler = vi.fn().mockResolvedValue({ accountIds: ["alice"] })) {
  const registry = createMockPluginRegistry([
    { hookName: "before_channel_participation", handler },
  ]);
  initializeGlobalHookRunner(registry);
  const coordinator = createChannelParticipationCoordinator<string>({ channel: "test" });
  const prepareAlice = vi.fn().mockResolvedValue(candidate("alice"));
  const prepareBob = vi.fn().mockResolvedValue(candidate("bob"));
  coordinator.register({ accountId: "alice", prepare: prepareAlice });
  const bob = coordinator.register({ accountId: "bob", prepare: prepareBob });
  const decide = (accountId = "bob", overrides: Partial<typeof source> = {}) =>
    coordinator.decide({ ...source, accountId, ...overrides });
  return { coordinator, prepareAlice, prepareBob, handler, registry, bob, decide };
}

afterEach(() => {
  resetGlobalHookRunner();
  vi.useRealTimers();
});

describe("channel participation", () => {
  it("shares one complete-roster decision regardless of which account arrives first", async () => {
    const { handler, decide } = setup();
    expect(await Promise.all([decide("bob"), decide("alice"), decide("bob")])).toEqual([
      "suppress",
      "keep",
      "suppress",
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      handler.mock.calls[0]?.[0].candidates.map(
        (entry: ChannelParticipationCandidate) => entry.accountId,
      ),
    ).toEqual(["alice", "bob"]);
  });

  it("does no receiver preparation when the optional policy is disabled", async () => {
    const { decide, prepareAlice, prepareBob } = setup();
    resetGlobalHookRunner();
    expect(await decide()).toBe("keep");
    expect(prepareAlice).not.toHaveBeenCalled();
    expect(prepareBob).not.toHaveBeenCalled();
  });

  it("never nominates an already handled event but retains a choice after normal adoption", async () => {
    const { decide, prepareAlice, handler } = setup();
    expect(await decide("alice")).toBe("keep");
    prepareAlice.mockResolvedValue({ ...candidate("alice"), alreadyHandled: true });
    expect(await decide("bob")).toBe("suppress");
    expect(await decide("bob", { eventKey: "$previously-consumed" })).toBe("keep");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("honors a receiver veto independently of selection eligibility", async () => {
    const { coordinator, decide, prepareAlice, handler } = setup(
      vi.fn().mockResolvedValue({ accountIds: ["carol"] }),
    );
    coordinator.register({ accountId: "carol", prepare: async () => candidate("carol") });
    prepareAlice.mockResolvedValue("bypass");
    expect(await decide("bob")).toBe("keep");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not disclose an ineligible source to policies even when two siblings qualify", async () => {
    const { coordinator, decide, prepareBob, handler } = setup();
    coordinator.register({ accountId: "carol", prepare: async () => candidate("carol") });
    prepareBob.mockResolvedValue(undefined);
    expect(await decide("bob")).toBe("keep");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([undefined, "bypass"])(
    "preserves ordinary activation when there is no ambiguous eligible roster (%j)",
    async (alice) => {
      const { decide, prepareAlice, handler } = setup();
      prepareAlice.mockResolvedValue(alice);
      expect(await decide()).toBe("keep");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("does not suppress a receiver that lost access while inference was running", async () => {
    const pending = createDeferred<{ accountIds: string[] }>();
    const started = createDeferred<void>();
    const { prepareAlice, decide } = setup(
      vi.fn().mockImplementation(() => {
        started.resolve();
        return pending.promise;
      }),
    );
    const reply = decide();
    await started.promise;
    prepareAlice.mockResolvedValue(undefined);
    pending.resolve({ accountIds: ["alice"] });
    expect(await reply).toBe("keep");
  });

  it("invalidates old choices after a receiver is replaced, including stale disposers", async () => {
    const { coordinator, decide, bob, handler } = setup();
    expect(await decide()).toBe("suppress");
    coordinator.register({ accountId: "bob", prepare: async () => candidate("bob") });
    bob.dispose();
    expect(await decide()).toBe("keep");
    expect(await decide("bob", { eventKey: "$new" })).toBe("suppress");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not reuse suppression after its policy registration is replaced", async () => {
    const { decide } = setup();
    expect(await decide()).toBe("suppress");
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_participation",
          handler: vi.fn().mockResolvedValue({ accountIds: ["bob"] }),
        },
      ]),
    );
    expect(await decide()).toBe("keep");
  });

  it("keeps conflicting copies of an exact event and scopes other native events separately", async () => {
    const { decide, handler } = setup();
    expect(await decide()).toBe("suppress");
    expect(await decide("bob", { message: "changed body" })).toBe("keep");
    expect(await decide()).toBe("keep");
    expect(await decide("bob", { eventKey: "$other" })).toBe("suppress");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps normal replies on preparation errors and oversized messages without calling the model", async () => {
    const { decide, prepareAlice, handler } = setup();
    expect(await decide("bob", { message: "x".repeat(2_001) })).toBe("keep");
    expect(prepareAlice).not.toHaveBeenCalled();
    prepareAlice.mockRejectedValue(new Error("membership unavailable"));
    expect(await decide()).toBe("keep");
    expect(handler).not.toHaveBeenCalled();
  });

  it("bounds stalled receiver preparation and never starts late inference", async () => {
    vi.useFakeTimers();
    const stalled = createDeferred<ChannelParticipationCandidate>();
    const { prepareAlice, decide, handler } = setup();
    prepareAlice.mockReturnValue(stalled.promise);
    const reply = decide();
    await vi.waitFor(() => expect(prepareAlice).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await reply).toBe("keep");
    stalled.resolve(candidate("alice"));
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("bounds revalidation and preserves replies when current access cannot be established", async () => {
    vi.useFakeTimers();
    const { prepareAlice, decide } = setup();
    prepareAlice.mockResolvedValueOnce(candidate("alice")).mockReturnValue(new Promise(() => {}));
    const reply = decide();
    await vi.waitFor(() => expect(prepareAlice).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await reply).toBe("keep");
  });

  it("retires an aborted receiver without suppressing the surviving account", async () => {
    const { coordinator, decide } = setup();
    const lifecycle = new AbortController();
    coordinator.register({
      accountId: "alice",
      prepare: async () => candidate("alice"),
      abortSignal: lifecycle.signal,
    });
    lifecycle.abort();
    expect(await decide()).toBe("keep");
  });
});
