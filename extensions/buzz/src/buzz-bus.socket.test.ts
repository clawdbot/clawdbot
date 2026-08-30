import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { createBuzzRelayFixture } from "./buzz-relay.test-harness.js";
import { startBuzzGatewayAccount } from "./gateway.js";
import { handleBuzzInbound } from "./inbound.js";
import { setBuzzRuntime } from "./runtime.js";
import { resolveBuzzAccount } from "./types.js";

let stateDir: string;
beforeEach(() => {
  // openclaw-temp-dir: allow extension tests cannot import root test helpers.
  stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-socket-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

it("delivers live messages on the room-scoped roster subscription", async () => {
  const fixture = await createBuzzRelayFixture();
  const messages: string[] = [];
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId],
      onMessage: async (message) => {
        messages.push(message.text);
      },
    });
    fixture.sendMessage("live after roster subscription");
    await vi.waitFor(() => expect(messages).toEqual(["live after roster subscription"]));
    const initial = fixture.events.find((event) => event.kind === 39002)!;
    const roster = {
      kind: 39002,
      created_at: initial.created_at + 1,
      content: "",
      tags: initial.tags.map((tag) =>
        tag[0] === "p" && tag[1] === fixture.senderPublicKey
          ? ["p", fixture.senderPublicKey, "", "bot"]
          : tag,
      ),
    };
    const valid = fixture.signRelay(roster);
    fixture.sendUnchecked({ ...valid, sig: "0".repeat(128) });
    fixture.sendUnchecked(
      fixture.signRelay({
        ...roster,
        tags: roster.tags.map((tag) => (tag[0] === "d" ? ["d", randomUUID()] : tag)),
      }),
    );
    await bus.sendText({ channelId: fixture.roomId, text: "invalid roster ordering barrier" });
    expect(
      bus.directory
        .listGroupMembers({ groupId: fixture.roomId })
        .find((member) => member.id === fixture.senderPublicKey)?.raw,
    ).toMatchObject({ role: "member" });
    fixture.broadcast(valid);
    await vi.waitFor(() =>
      expect(
        bus?.directory
          .listGroupMembers({ groupId: fixture.roomId })
          .find((member) => member.id === fixture.senderPublicKey)?.raw,
      ).toMatchObject({ role: "bot" }),
    );
  } finally {
    await bus?.close();
    await fixture.close();
  }
});

it("keeps removal denied through stale snapshots and accepts a confirmed rejoin", async () => {
  const fixture = await createBuzzRelayFixture();
  const messages: string[] = [];
  const fatal: Error[] = [];
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId],
      onMessage: async (message) => {
        messages.push(message.text);
      },
      onFatalError: (error) => fatal.push(error),
    });
    const initial = fixture.events.find((event) => event.kind === 39002)!;
    const query = fixture.pauseNextMembershipQuery();
    fixture.broadcast(
      fixture.signRelay({
        kind: 40099,
        created_at: Math.floor(Date.now() / 1000),
        content: JSON.stringify({ type: "member_removed", target: fixture.senderPublicKey }),
        tags: [["h", fixture.roomId]],
      }),
    );
    await query.started;
    fixture.broadcast(initial);
    fixture.sendMessage("removed sender");
    query.release();
    await bus.sendText({ channelId: fixture.roomId, text: "removal ordering barrier" });
    expect(messages).toEqual([]);
    expect(
      bus.directory
        .listGroupMembers({ groupId: fixture.roomId })
        .some((entry) => entry.id === fixture.senderPublicKey),
    ).toBe(false);

    fixture.broadcast(
      fixture.signRelay({
        kind: 40099,
        created_at: initial.created_at + 1,
        content: JSON.stringify({ type: "member_joined", target: fixture.senderPublicKey }),
        tags: [["h", fixture.roomId]],
      }),
    );
    fixture.broadcast(
      fixture.signRelay({
        kind: 39002,
        created_at: initial.created_at + 1,
        content: "",
        tags: initial.tags,
      }),
    );
    await vi.waitFor(
      () =>
        expect(
          bus?.directory
            .listGroupMembers({ groupId: fixture.roomId })
            .some((entry) => entry.id === fixture.senderPublicKey),
        ).toBe(true),
      { timeout: 6000 },
    );
    fixture.sendMessage("confirmed rejoin");
    await vi.waitFor(() => expect(messages).toEqual(["confirmed rejoin"]));
    expect(fatal).toEqual([]);
  } finally {
    await bus?.close();
    await fixture.close();
  }
});

it("finishes an admitted room turn after its sender is removed", async () => {
  const fixture = await createBuzzRelayFixture();
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStore = (options) => createPluginStateKeyedStoreForTests("buzz", options);
  setBuzzRuntime(runtime);
  const dispatched = createDeferred<void>();
  const continueTurn = createDeferred<void>();
  const completed = createDeferred<void>();
  const cfg = {
    channels: {
      buzz: {
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        groupPolicy: "open",
        groups: { [fixture.roomId]: { requireMention: false } },
      },
    },
  } satisfies OpenClawConfig;
  const account = resolveBuzzAccount({ cfg });
  vi.mocked(runtime.channel.inbound.dispatch).mockImplementation(async (params) => {
    dispatched.resolve();
    await continueTurn.promise;
    await params.delivery.deliver({ text: "admitted room reply" }, { kind: "final" });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: params.ctxPayload,
      routeSessionKey: params.route.sessionKey,
      dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
    };
  });
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: account.accountId,
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId],
      onMessage: async (message, activeBus, signal, assertCurrent) => {
        await handleBuzzInbound({
          account,
          cfg,
          bus: activeBus,
          message,
          signal,
          assertCurrent,
          historyMap: new Map(),
        });
        completed.resolve();
      },
      onMessageError: completed.reject,
    });
    const message = fixture.sendMessage("accepted before removal");
    await dispatched.promise;
    const initial = fixture.events.find((event) => event.kind === 39002)!;
    fixture.broadcast(
      fixture.signRelay({
        kind: 39002,
        created_at: initial.created_at + 1,
        content: "",
        tags: initial.tags.filter((tag) => tag[0] !== "p" || tag[1] !== fixture.senderPublicKey),
      }),
    );
    await vi.waitFor(() =>
      expect(
        bus?.directory
          .listGroupMembers({ groupId: fixture.roomId })
          .some((member) => member.id === fixture.senderPublicKey),
      ).toBe(false),
    );
    continueTurn.resolve();
    await completed.promise;
    const replies = fixture.events.filter(
      (event) => event.pubkey === fixture.botPublicKey && event.kind === 9,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      content: "admitted room reply",
      tags: expect.arrayContaining([
        ["h", fixture.roomId],
        ["e", message.id, "", "reply"],
      ]),
    });
  } finally {
    continueTurn.resolve();
    await bus?.close();
    await fixture.close();
  }
});

it("revokes the active bot immediately on a signed role downgrade", async () => {
  const fixture = await createBuzzRelayFixture();
  const fatal: Error[] = [];
  let turnSignal: AbortSignal | undefined;
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId],
      onMessage: async (_message, _bus, signal) => {
        turnSignal = signal;
      },
      onFatalError: (error) => fatal.push(error),
    });
    fixture.sendMessage("before bot downgrade");
    await vi.waitFor(() => expect(turnSignal).toBeDefined());
    const initial = fixture.events.find((event) => event.kind === 39002)!;
    fixture.broadcast(
      fixture.signRelay({
        kind: 39002,
        created_at: initial.created_at + 1,
        content: "",
        tags: initial.tags.map((tag) =>
          tag[0] === "p" && tag[1] === fixture.botPublicKey
            ? ["p", fixture.botPublicKey, "", "member"]
            : tag,
        ),
      }),
    );
    await vi.waitFor(() => expect(fatal).toHaveLength(1));
    expect(fatal[0]?.message).toContain("no longer has the Bot role");
    expect(turnSignal?.aborted).toBe(true);
    await expect(
      bus.sendText({ channelId: fixture.roomId, text: "retired bot reply" }),
    ).rejects.toThrow("no longer has the Bot role");
  } finally {
    await bus?.close();
    await fixture.close();
  }
});
afterEach(() => {
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

it("recovers the Gateway account after silent presence without replaying pre-activation messages", async () => {
  const fixture = await createBuzzRelayFixture();
  fixture.setPresenceMode("silent");
  fixture.sendMessage("pre-activation", Math.floor(Date.now() / 1000) - 60);
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStore = (options) => createPluginStateKeyedStoreForTests("buzz", options);
  setBuzzRuntime(runtime);
  const handled: string[] = [];
  vi.mocked(runtime.channel.inbound.dispatch).mockImplementation(async (params) => {
    handled.push(String(params.ctxPayload.RawBody));
    await params.delivery.deliver({ text: "gateway socket reply" }, { kind: "final" });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: params.ctxPayload,
      routeSessionKey: params.route.sessionKey,
      dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
    };
  });
  const cfg = {
    channels: {
      buzz: {
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        groupPolicy: "open",
        groups: { [fixture.roomId]: { requireMention: false } },
      },
    },
  } satisfies OpenClawConfig;
  const account = resolveBuzzAccount({ cfg });
  const abort = new AbortController();
  const states: string[] = [];
  const ctx = createStartAccountContext({
    account,
    cfg,
    abortSignal: abort.signal,
    statusPatchSink: (next) => {
      if (next.lifecycle) {
        states.push(next.lifecycle);
      }
      if (next.lifecycle === "recovering") {
        fixture.setPresenceMode("accept");
        fixture.sendMessage("during reconnect");
      }
    },
  });
  const lifecycle = startBuzzGatewayAccount(ctx);
  void lifecycle.catch(() => {});
  try {
    await vi.waitFor(() => expect(states).toContain("ready"));
    fixture.sendMessage("before stall");
    await vi.waitFor(() => expect(handled).toContain("before stall"));
    await vi.waitFor(() => expect(fixture.authenticatedSessions()).toBe(2), { timeout: 8000 });
    await vi.waitFor(() => expect(handled).toContain("during reconnect"));
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(states).toContain("recovering");
    expect(handled).toEqual(["before stall", "during reconnect"]);
    await vi.waitFor(() =>
      expect(
        fixture.received.filter((event) => event.content === "gateway socket reply"),
      ).toHaveLength(2),
    );
  } finally {
    abort.abort();
    await lifecycle;
    await fixture.close();
  }
}, 15000);

it("accepts a startup bot-join notification already reflected in the signed roster", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Math.floor(Date.now() / 1000) * 1000);
  const fixture = await createBuzzRelayFixture();
  fixture.events.push(
    fixture.signRelay({
      kind: 40099,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ type: "member_joined", target: fixture.botPublicKey }),
      tags: [["h", fixture.roomId]],
    }),
  );
  const fatal: Error[] = [];
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId],
      onMessage: async () => {},
      onFatalError: (error) => fatal.push(error),
    });
    // Restoring the directory proves the pending self-membership refresh settled,
    // rather than silently retrying until the existing bounded refresh times out.
    await vi.waitFor(
      () =>
        expect(
          bus?.directory
            .listGroupMembers({ groupId: fixture.roomId })
            .some((entry) => entry.id === fixture.botPublicKey),
        ).toBe(true),
      { timeout: 6500 },
    );
    expect(fatal).toEqual([]);
  } finally {
    await bus?.close();
    await fixture.close();
  }
}, 10000);

it.each(["reject", "silent"] as const)(
  "distinguishes %s presence acknowledgement over a real socket",
  async (mode) => {
    const fixture = await createBuzzRelayFixture();
    fixture.setPresenceMode(mode);
    const errors: Error[] = [];
    const fatal: Error[] = [];
    const messages: string[] = [];
    let turnSignal: AbortSignal | undefined;
    let bus: BuzzBus | undefined;
    try {
      bus = await startBuzzBus({
        accountId: randomUUID(),
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        channelIds: [fixture.roomId],
        onMessage: async (message, _bus, signal) => {
          messages.push(message.text);
          turnSignal = signal;
        },
        onPresenceError: (error) => errors.push(error),
        onFatalError: (error) => {
          fatal.push(error);
          void bus?.close();
        },
      });
      fixture.sendMessage("socket canary");
      await vi.waitFor(() => expect(messages).toEqual(["socket canary"]));
      expect(fixture.authenticatedSessions()).toBe(1);
      if (mode === "silent") {
        // nostr-tools' real 4.4s publish timer rejects without closing the socket.
        await vi.waitFor(() => expect(fatal).toHaveLength(1), { timeout: 6000 });
        expect(fatal[0]?.message).toContain("publish timed out");
        await vi.waitFor(() => expect(turnSignal?.aborted).toBe(true));
      } else {
        await vi.waitFor(() => expect(errors).toHaveLength(1));
        expect(fatal).toEqual([]);
        expect(turnSignal?.aborted).toBe(false);
        await bus.sendText({ channelId: fixture.roomId, text: "healthy after rejection" });
        expect(fixture.received.some((event) => event.content === "healthy after rejection")).toBe(
          true,
        );
      }
    } finally {
      await bus?.close();
      await fixture.close();
    }
  },
  12000,
);

it.each(["before", "after"] as const)(
  "keeps the signed role when an older query completes %s the push",
  async (queryOrder) => {
    const fixture = await createBuzzRelayFixture();
    let bus: BuzzBus | undefined;
    try {
      bus = await startBuzzBus({
        accountId: randomUUID(),
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        channelIds: [fixture.roomId],
        onMessage: async () => {},
      });
      const initial = fixture.events.find((event) => event.kind === 39002)!;
      const change = fixture.signRelay({
        kind: 40099,
        created_at: Math.floor(Date.now() / 1000),
        content: JSON.stringify({ type: "member_joined", target: fixture.senderPublicKey }),
        tags: [["h", fixture.roomId]],
      });
      const query = fixture.pauseNextMembershipQuery();
      fixture.broadcast(change);
      const updated = fixture.signRelay({
        kind: 39002,
        created_at: initial.created_at + 1,
        content: "",
        tags: initial.tags.map((tag) =>
          tag[0] === "p" && tag[1] === fixture.senderPublicKey
            ? ["p", fixture.senderPublicKey, "", "bot"]
            : tag,
        ),
      });
      await query.started;
      if (queryOrder === "before") {
        query.release();
      }
      fixture.broadcast(updated);
      fixture.broadcast(change);
      await vi.waitFor(() =>
        expect(
          bus?.directory
            .listGroupMembers({ groupId: fixture.roomId })
            .find((member) => member.id === fixture.senderPublicKey)?.raw,
        ).toMatchObject({ role: "bot" }),
      );
      if (queryOrder === "after") {
        query.release();
        // A publish acknowledgement follows the old query frames on this socket.
        await bus.sendText({ channelId: fixture.roomId, text: "query ordering barrier" });
        expect(
          bus.directory
            .listGroupMembers({ groupId: fixture.roomId })
            .find((member) => member.id === fixture.senderPublicKey)?.raw,
        ).toMatchObject({ role: "bot" });
      }
    } finally {
      await bus?.close();
      await fixture.close();
    }
  },
);
