import { compareEvents, finalizeEvent } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";

const { PRIVATE_KEY, CHANNEL_ID, startTestBus, signSenderEvent, subscriptionIncludesKind } =
  useBuzzBusLifecycleFixture();

describe("Buzz profile lifecycle", () => {
  it("selects the lowest event ID when profiles share a timestamp", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const secretKey = Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex"));
    const profiles = ["First profile", "Second profile"].map((displayName) =>
      finalizeEvent(
        {
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: displayName }),
          tags: [],
        },
        secretKey,
      ),
    );
    const sortedProfiles = profiles.toSorted(compareEvents);
    const lowerIdProfile = sortedProfiles[0];
    const higherIdProfile = sortedProfiles[1];
    if (!lowerIdProfile || !higherIdProfile) {
      throw new Error("Expected two signed profile fixtures");
    }
    relayMocks.profileEvents = [higherIdProfile, lowerIdProfile];

    const bus = await startTestBus({ profileName: "Configured Agent Name" });

    await vi.waitFor(() =>
      expect(relayMocks.publish.mock.calls.some(([event]) => event.kind === 10_100)).toBe(true),
    );
    const agentProfile = relayMocks.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.kind === 10_100);
    expect(JSON.parse(agentProfile?.content ?? "{}")).toMatchObject({
      name: JSON.parse(lowerIdProfile.content).display_name,
      display_name: JSON.parse(lowerIdProfile.content).display_name,
    });
    await bus.close();
  });

  it("isolates message failures from fatal relay failures", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.profileEvents = [
      finalizeEvent(
        {
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: "Existing Buzz Name", about: "kept" }),
          tags: [],
        },
        Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")),
      ),
    ];
    const onMessageError = vi.fn();
    const onFatalError = vi.fn();
    const onProfilePublished = vi.fn();
    const bus = await startTestBus({
      onMessage: async () => {
        throw new Error("dispatch failed");
      },
      profileName: "Configured Agent Name",
      onMessageError,
      onFatalError,
      onProfilePublished,
    });
    const event = signSenderEvent({
      kind: 9,
      created_at: 1_700_000_000,
      content: "hello",
      tags: [["h", CHANNEL_ID]],
    });

    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 9))
      ?.handlers.onevent(event);

    await vi.waitFor(() => expect(onMessageError).toHaveBeenCalledWith(expect.any(Error)));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(
      relayMocks.publish.mock.calls.some(([publishedEvent]) => publishedEvent.kind === 0),
    ).toBe(false);
    expect(
      relayMocks.publish.mock.calls.some(([publishedEvent]) => publishedEvent.kind === 10_100),
    ).toBe(true);
    expect(onProfilePublished).toHaveBeenCalledOnce();
    expect(onFatalError).not.toHaveBeenCalled();
    await bus.close();
  });

  it.each([
    { phase: "query EOSE", gatedKind: undefined, publishedKinds: [] },
    { phase: "first ACK", gatedKind: 0, publishedKinds: [0] },
    { phase: "final ACK", gatedKind: 10_100, publishedKinds: [0, 10_100] },
    { phase: "relay close", gatedKind: 10_100, publishedKinds: [0, 10_100] },
  ])(
    "settles profile work without post-abort effects at $phase",
    async ({ phase, gatedKind, publishedKinds }) => {
      relayMocks.auth.mockResolvedValue("ok");
      relayMocks.stallProfileQueryEose = phase === "query EOSE";
      const acknowledgement = createDeferred<string>();
      const dispatchCleanup = createDeferred<void>();
      const publishCleanup = createDeferred<void>();
      let publishUnwinding = false;
      relayMocks.publish.mockImplementation(async (event) => {
        if (event.kind !== gatedKind) {
          return "ok";
        }
        try {
          return await acknowledgement.promise;
        } finally {
          if (phase === "relay close") {
            publishUnwinding = true;
            await publishCleanup.promise;
          }
        }
      });
      if (phase === "relay close") {
        // nostr-tools rejects pending publish acknowledgements synchronously in close().
        relayMocks.close.mockImplementationOnce(() => {
          acknowledgement.reject(new Error("relay connection closed by us"));
        });
      }
      const onMessage = vi.fn(async () => await dispatchCleanup.promise);
      const onProfilePublished = vi.fn();
      const onProfileError = vi.fn();
      const bus = await startTestBus({
        profileName: "OpenClaw",
        onMessage,
        onProfilePublished,
        onProfileError,
      });
      const profileKinds = () =>
        relayMocks.publish.mock.calls
          .map(([event]) => event.kind)
          .filter((kind) => kind === 0 || kind === 10_100);
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        if (gatedKind !== undefined) {
          await vi.waitFor(() => expect(profileKinds()).toContain(gatedKind));
        }
        const messageSubscription = relayMocks.subscriptions.find((entry) =>
          subscriptionIncludesKind(entry, 9),
        );
        if (!messageSubscription) {
          throw new Error("Buzz live room subscription is missing");
        }
        messageSubscription.handlers.onevent(
          signSenderEvent({
            kind: 9,
            created_at: 1_700_000_000,
            content: "hold admitted cleanup",
            tags: [["h", CHANNEL_ID]],
          }),
        );
        await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
        if (phase === "query EOSE") {
          const query = relayMocks.subscriptions.find((entry) =>
            subscriptionIncludesKind(entry, 10_100),
          );
          if (!query?.handlers.oneose) {
            throw new Error("Buzz profile query is missing its EOSE handler");
          }
          query.handlers.oneose();
        }
        closing = bus.close().then(() => {
          closed = true;
        });
        if (phase !== "relay close") {
          acknowledgement.resolve("ok");
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(profileKinds()).toEqual(publishedKinds);
        expect(onProfilePublished).not.toHaveBeenCalled();
        expect(onProfileError).not.toHaveBeenCalled();
        expect(closed).toBe(false);
        expect(relayMocks.close).not.toHaveBeenCalled();
        dispatchCleanup.resolve();
        if (phase === "relay close") {
          await vi.waitFor(() => expect(publishUnwinding).toBe(true));
          expect(relayMocks.close).toHaveBeenCalledOnce();
          expect(closed).toBe(false);
          publishCleanup.resolve();
        }
        await vi.waitFor(() => expect(closed).toBe(true));
        await closing;
        expect(profileKinds()).toEqual(publishedKinds);
        expect(onProfilePublished).not.toHaveBeenCalled();
        expect(onProfileError).not.toHaveBeenCalled();
      } finally {
        dispatchCleanup.resolve();
        acknowledgement.resolve("cleanup");
        publishCleanup.resolve();
        await (closing ?? bus.close());
        relayMocks.close.mockReset();
      }
    },
  );

  it("recycles the Buzz bus when profile synchronization never reaches EOSE", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.stallProfileQueryEose = true;
    const onFatalError = vi.fn();
    const onProfileError = vi.fn();
    const bus = await startTestBus({
      profileName: "Configured Agent Name",
      onFatalError,
      onProfileError,
    });

    expect(
      relayMocks.subscriptions.some((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(10_100)),
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Timed out loading current Buzz profile" }),
    );
    expect(relayMocks.close).toHaveBeenCalledOnce();
    expect(onProfileError).not.toHaveBeenCalled();

    await bus.close();
  });
});
