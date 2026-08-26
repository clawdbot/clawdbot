import {
  buildChannelInboundEventContext,
  runPreparedInboundReply,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
// Buzz tests cover inbound room admission, mention gating, and reply delivery.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzBus } from "./buzz-bus.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { handleBuzzInbound } from "./inbound.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_NORMAL_MESSAGE_KIND,
  type BuzzInboundMessage,
} from "./message-event.js";
import { setBuzzRuntime } from "./runtime.js";
import type { ResolvedBuzzAccount } from "./types.js";

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    buildChannelInboundEventContext: vi.fn(actual.buildChannelInboundEventContext),
  };
});
vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-ingress-runtime")>();
  return {
    ...actual,
    resolveStableChannelMessageIngress: vi.fn(actual.resolveStableChannelMessageIngress),
  };
});

const ROOM_ID = "b25b8e40-eb1a-43a4-b56b-30a4e16df586";
const BOT_PUBLIC_KEY = "a".repeat(64);
const SENDER_PUBLIC_KEY = "b".repeat(64);
const OTHER_PUBLIC_KEY = "c".repeat(64);

function createAccount(
  configOverrides: Partial<ResolvedBuzzAccount["config"]> = {},
): ResolvedBuzzAccount {
  return {
    accountId: "default",
    name: "OpenClaw",
    enabled: true,
    configured: true,
    relayUrl: "ws://127.0.0.1:3000",
    privateKey: "1".repeat(64),
    authTag: "",
    publicKey: BOT_PUBLIC_KEY,
    config: {
      groupPolicy: "open",
      groups: {
        [ROOM_ID]: {
          requireMention: true,
        },
      },
      ...configOverrides,
    },
  };
}

function createMessage(overrides: Partial<BuzzInboundMessage> = {}): BuzzInboundMessage {
  return {
    id: "event-1",
    kind: BUZZ_NORMAL_MESSAGE_KIND,
    senderPubkey: SENDER_PUBLIC_KEY,
    text: "hello",
    channelId: ROOM_ID,
    createdAt: 1_777_000_000,
    mentionedPubkeys: [],
    ...overrides,
  };
}

function createLifecycle() {
  const signal = new AbortController().signal;
  return { signal, assertCurrent: () => signal.throwIfAborted() };
}

function createBus(): BuzzBus {
  return {
    publicKey: BOT_PUBLIC_KEY,
    directory: new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [ROOM_ID],
    }),
    refreshDirectory: vi.fn(async () => {}),
    sendText: vi.fn(async () => "reply-event-1"),
    sendTyping: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function firstDispatch(
  runtime: ReturnType<typeof createPluginRuntimeMock>,
): Parameters<typeof runtime.channel.inbound.dispatch>[0] {
  const call = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0];
  if (!call) {
    throw new Error("expected Buzz inbound dispatch");
  }
  return call[0];
}

describe("handleBuzzInbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a native Nostr public-key mention", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    const lifecycle = createLifecycle();

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({ mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      ...lifecycle,
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    expect(firstDispatch(runtime).replyOptions?.abortSignal).toBe(lifecycle.signal);
    expect(firstDispatch(runtime).ctxPayload).toMatchObject({
      WasMentioned: true,
      SenderId: SENDER_PUBLIC_KEY,
      ChatId: ROOM_ID,
      NativeChannelId: ROOM_ID,
      GroupSubject: ROOM_ID,
    });
    expect(firstDispatch(runtime).ctxPayload.GroupChannel).toBeUndefined();
    const resolverResult = await vi.mocked(resolveStableChannelMessageIngress).mock.results[0]
      ?.value;
    expect(vi.mocked(buildChannelInboundEventContext).mock.calls[0]?.[0].channelIngress).toBe(
      resolverResult,
    );
  });

  it("uses current Buzz labels without changing the stable sender identity", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    const bus = createBus();
    bus.directory.replaceMemberships(
      new Map([
        [
          ROOM_ID,
          {
            roomId: ROOM_ID,
            createdAt: 1_777_000_000,
            eventId: "membership-1",
            publisherPublicKey: OTHER_PUBLIC_KEY,
            members: new Set([BOT_PUBLIC_KEY, SENDER_PUBLIC_KEY]),
            roles: new Map([
              [BOT_PUBLIC_KEY, "bot"],
              [SENDER_PUBLIC_KEY, "member"],
            ]),
          },
        ],
      ]),
    );
    bus.directory.applyProfileEvent({
      id: "profile-1",
      kind: 0,
      pubkey: SENDER_PUBLIC_KEY,
      created_at: 1_777_000_000,
      content: JSON.stringify({ display_name: "Alice" }),
      sig: "e".repeat(128),
      tags: [],
    });
    bus.directory.applyRoomEvent({
      id: "room-1",
      kind: 39_000,
      pubkey: OTHER_PUBLIC_KEY,
      created_at: 1_777_000_000,
      content: "",
      sig: "e".repeat(128),
      tags: [
        ["d", ROOM_ID],
        ["name", "Engineering"],
      ],
    });

    await handleBuzzInbound({
      account: createAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: [SENDER_PUBLIC_KEY],
        groups: { [ROOM_ID]: { requireMention: false } },
      }),
      cfg: {} satisfies OpenClawConfig,
      bus,
      message: createMessage(),
      ...createLifecycle(),
    });

    expect(firstDispatch(runtime).ctxPayload).toMatchObject({
      SenderId: SENDER_PUBLIC_KEY,
      SenderName: "Alice",
      ChatId: ROOM_ID,
      NativeChannelId: ROOM_ID,
      GroupSubject: "Engineering",
    });
    expect(firstDispatch(runtime).ctxPayload.GroupChannel).toBeUndefined();
  });

  it("accepts a configured text mention when no native p tag is present", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.mentions.buildMentionRegexes).mockReturnValue([/@openclaw/i]);
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({ text: "@openclaw status" }),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    expect(firstDispatch(runtime).ctxPayload.WasMentioned).toBe(true);
  });

  it("drops room messages that miss required mention activation", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage(),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["membership", true],
    ["shutdown", true],
    ["membership", false],
    ["shutdown", false],
  ] as const)(
    "rechecks %s after asynchronous ingress admission (mentioned: %s)",
    async (change, mentioned) => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const actual = await vi.importActual<
        typeof import("openclaw/plugin-sdk/channel-ingress-runtime")
      >("openclaw/plugin-sdk/channel-ingress-runtime");
      const abort = new AbortController();
      let currentMember = true;
      let releaseAdmission: () => void = () => {};
      const admissionGate = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      vi.mocked(resolveStableChannelMessageIngress).mockImplementationOnce(async (params) => {
        const access = await actual.resolveStableChannelMessageIngress(params);
        await admissionGate;
        return access;
      });
      const params = {
        account: createAccount(),
        cfg: {} satisfies OpenClawConfig,
        bus: createBus(),
        message: createMessage({ mentionedPubkeys: mentioned ? [BOT_PUBLIC_KEY] : [] }),
        signal: abort.signal,
        assertCurrent: () => {
          abort.signal.throwIfAborted();
          if (!currentMember) {
            throw new Error("Buzz sender is no longer a room member");
          }
        },
      };
      const inbound = handleBuzzInbound(params);
      await vi.waitFor(() => expect(resolveStableChannelMessageIngress).toHaveBeenCalledOnce());
      if (change === "membership") {
        currentMember = false;
      } else {
        abort.abort(new Error("Buzz bus closed"));
      }
      releaseAdmission();

      await expect(inbound).rejects.toThrow(
        change === "membership" ? "no longer a room member" : "Buzz bus closed",
      );
      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    },
  );

  it("drops mentioned room messages from senders outside the allowlist", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: [OTHER_PUBLIC_KEY],
      }),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({ mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { role: "bot", enabled: true, dispatches: 1 },
    { role: "member", enabled: true, dispatches: 2 },
    { role: undefined, enabled: true, dispatches: 2 },
    { role: "bot", enabled: false, dispatches: 2 },
  ])(
    "bounds current roster role $role with protection enabled=$enabled",
    async ({ role, enabled, dispatches }) => {
      const runtime = createPluginRuntimeMock();
      const runDispatch = vi.fn(async () => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 1 },
      }));
      const recordInboundSession = vi.fn(async () => undefined);
      vi.mocked(runtime.channel.inbound.dispatch).mockImplementation(async (params) =>
        runPreparedInboundReply({
          ...params,
          routeSessionKey: params.route.sessionKey,
          storePath: "/unused/buzz-bot-loop",
          recordInboundSession,
          runDispatch,
        }),
      );
      setBuzzRuntime(runtime);
      const bus = createBus();
      bus.directory.replaceMemberships(
        new Map([
          [
            ROOM_ID,
            {
              roomId: ROOM_ID,
              createdAt: 1_777_000_000,
              eventId: "membership-bot-loop",
              publisherPublicKey: OTHER_PUBLIC_KEY,
              members: new Set([BOT_PUBLIC_KEY, SENDER_PUBLIC_KEY]),
              roles: new Map(role ? [[SENDER_PUBLIC_KEY, role]] : []),
            },
          ],
        ]),
      );
      const account = createAccount({ groups: { [ROOM_ID]: { requireMention: false } } });
      const relayHost = `loop-${role ?? "unknown"}-${enabled}.example.test`;
      account.relayUrl = `wss://${relayHost}/`;
      const cfg = {
        channels: {
          defaults: {
            botLoopProtection: {
              enabled,
              maxEventsPerWindow: 1,
              windowSeconds: 60,
              cooldownSeconds: 60,
            },
          },
        },
      } satisfies OpenClawConfig;
      for (const [index, id] of ["loop-first", "loop-second"].entries()) {
        if (index === 1) {
          account.relayUrl = `wss://${relayHost.toUpperCase()}:443/`;
        }
        await handleBuzzInbound({
          account,
          cfg,
          bus,
          message: createMessage({ id, threadId: id, createdAt: 1_777_000_000 + index * 86_400 }),
          ...createLifecycle(),
        });
      }

      expect(runDispatch).toHaveBeenCalledTimes(dispatches);
      expect(recordInboundSession).toHaveBeenCalledTimes(dispatches);
    },
  );

  it.each([
    {
      name: "restricts an otherwise open account to the room allowlist",
      accountPolicy: "open",
      accountAllowFrom: undefined,
      room: { groupPolicy: "allowlist", groupAllowFrom: [OTHER_PUBLIC_KEY] },
      dispatches: false,
    },
    {
      name: "opens one room without changing the account allowlist",
      accountPolicy: "allowlist",
      accountAllowFrom: [OTHER_PUBLIC_KEY],
      room: { groupPolicy: "open" },
      dispatches: true,
    },
    {
      name: "inherits the account policy with a room-specific allowlist",
      accountPolicy: "allowlist",
      accountAllowFrom: [OTHER_PUBLIC_KEY],
      room: { groupAllowFrom: [SENDER_PUBLIC_KEY] },
      dispatches: true,
    },
    {
      name: "keeps an explicitly empty room allowlist fail-closed",
      accountPolicy: "allowlist",
      accountAllowFrom: [SENDER_PUBLIC_KEY],
      room: { groupAllowFrom: [] },
      dispatches: false,
    },
    {
      name: "inherits the account allowlist when a room only sets its policy",
      accountPolicy: "open",
      accountAllowFrom: [SENDER_PUBLIC_KEY],
      room: { groupPolicy: "allowlist" },
      dispatches: true,
    },
    {
      name: "disables one room without changing the account policy",
      accountPolicy: "open",
      accountAllowFrom: undefined,
      room: { groupPolicy: "disabled" },
      dispatches: false,
    },
  ] as const)("$name", async ({ accountPolicy, accountAllowFrom, room, dispatches }) => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount({
        groupPolicy: accountPolicy,
        groupAllowFrom: accountAllowFrom ? [...accountAllowFrom] : undefined,
        groups: {
          [ROOM_ID]: {
            requireMention: false,
            ...room,
            groupAllowFrom: room.groupAllowFrom ? [...room.groupAllowFrom] : undefined,
          },
        },
      }),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage(),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(dispatches ? 1 : 0);
  });

  it("authorizes commands from an allowlisted room sender", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.text.hasControlCommand).mockReturnValue(true);
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: [OTHER_PUBLIC_KEY],
        groups: { [ROOM_ID]: { requireMention: true, groupAllowFrom: [SENDER_PUBLIC_KEY] } },
      }),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({
        text: "/status",
      }),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    expect(firstDispatch(runtime).ctxPayload).toMatchObject({
      CommandAuthorized: true,
      CommandBody: "/status",
    });
  });

  it("drops unauthorized room control commands instead of bypassing mentions", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.text.hasControlCommand).mockReturnValue(true);
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({ text: "/status" }),
      ...createLifecycle(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("anchors Buzz agent replies and typing to the original thread root", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    const bus = createBus();

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus,
      message: createMessage({
        id: "event-reply",
        threadId: "event-root",
        mentionedPubkeys: [BOT_PUBLIC_KEY],
      }),
      ...createLifecycle(),
    });

    const dispatch = firstDispatch(runtime);
    expect(dispatch.ctxPayload).toMatchObject({
      MessageSid: "event-reply",
      MessageThreadId: "event-root",
      ReplyToId: "event-reply",
      ThreadParentId: ROOM_ID,
    });

    await dispatch.delivery.deliver({ text: "  " }, { kind: "final" });
    expect(bus.sendText).not.toHaveBeenCalled();

    await dispatch.delivery.deliver({ text: "threaded reply to @Alice" }, { kind: "final" });
    expect(bus.sendText).toHaveBeenCalledWith({
      channelId: ROOM_ID,
      text: "threaded reply to @Alice",
      threadId: "event-root",
      replyToId: "event-root",
    });

    const typing = dispatch.replyPipeline?.typing;
    expect(typing?.keepaliveIntervalMs).toBe(3_000);
    await typing?.start();
    expect(bus.sendTyping).toHaveBeenCalledWith({
      channelId: ROOM_ID,
      threadId: "event-root",
      replyToId: "event-root",
    });
  });

  it("provides bounded structured diff context without treating diff content as commands", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    setBuzzRuntime(runtime);
    const diffText = `/status\n@@ -1 +1 @@\n-old\n+${"new".repeat(4_000)}`;

    await handleBuzzInbound({
      account: createAccount({
        groups: {
          [ROOM_ID]: {
            requireMention: false,
          },
        },
      }),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({
        kind: BUZZ_DIFF_MESSAGE_KIND,
        text: diffText,
        diff: {
          repoUrl: "https://github.com/openclaw/openclaw",
          commitSha: "abcdef1",
          description: `line one\n${"x".repeat(1_100)}`,
          truncated: true,
        },
      }),
      ...createLifecycle(),
    });

    expect(runtime.channel.commands.shouldComputeCommandAuthorized).not.toHaveBeenCalled();
    const context = firstDispatch(runtime).ctxPayload;
    expect(context).toMatchObject({
      BuzzEventKind: BUZZ_DIFF_MESSAGE_KIND,
      RawBody: diffText,
      CommandBody: "",
      BodyForCommands: "",
    });
    const bodyForAgent = context.BodyForAgent ?? "";
    expect(bodyForAgent).toContain("[Buzz structured diff]");
    expect(bodyForAgent).toContain("Repository: https://github.com/openclaw/openclaw");
    expect(bodyForAgent).toContain("Description: line one ");
    expect(bodyForAgent).toContain("Truncated: yes");
    expect(bodyForAgent).toContain("Unified diff:\n/status\n@@ -1 +1 @@\n-old\n+new");
    expect(bodyForAgent.endsWith("...[Buzz diff truncated for model context]")).toBe(true);
    expect(bodyForAgent.length).toBeLessThanOrEqual(4_000);
  });

  it("does not treat mention-like text inside a structured diff as a bot mention", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.mentions.matchesMentionPatterns).mockReturnValue(true);
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({
        kind: BUZZ_DIFF_MESSAGE_KIND,
        text: "+const owner = '@OpenClaw';",
        diff: {
          repoUrl: "https://github.com/openclaw/openclaw",
          commitSha: "abcdef1",
          truncated: false,
        },
      }),
      ...createLifecycle(),
    });

    expect(runtime.channel.mentions.matchesMentionPatterns).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("propagates delivery and session-recording failures", async () => {
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({ mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      ...createLifecycle(),
    });

    const dispatch = firstDispatch(runtime);
    expect(() => dispatch.delivery.onError?.("send failed", { kind: "final" })).toThrow(
      "send failed",
    );
    expect(() => dispatch.record?.onRecordError?.("store failed")).toThrow(
      "Buzz session record failed: store failed",
    );
  });
});
