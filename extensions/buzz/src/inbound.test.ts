import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
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
  buildBuzzMessageTags,
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

function createSignal(): AbortSignal {
  return new AbortController().signal;
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
    const signal = createSignal();

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({ mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      signal,
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    expect(firstDispatch(runtime).replyOptions?.abortSignal).toBe(signal);
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
      signal: createSignal(),
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
      signal: createSignal(),
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
      signal: createSignal(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

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
      signal: createSignal(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("authorizes commands from an allowlisted room sender", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.text.hasControlCommand).mockReturnValue(true);
    setBuzzRuntime(runtime);

    await handleBuzzInbound({
      account: createAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: [SENDER_PUBLIC_KEY],
      }),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({
        text: "/status",
      }),
      signal: createSignal(),
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
      signal: createSignal(),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "thread-child",
      message: { id: "event-reply", threadId: "event-root" },
      context: {
        MessageSid: "event-reply",
        MessageThreadId: "event-root",
        ReplyToId: "event-root",
        ThreadParentId: ROOM_ID,
      },
    },
    {
      name: "top-level",
      message: { id: "event-root" },
      context: {
        MessageSid: "event-root",
        ReplyToId: "event-root",
      },
    },
  ])(
    "publishes $name ordinary replies directly to the Buzz conversation root",
    async (testCase) => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const bus = createBus();
      const publishedTags: string[][][] = [];
      vi.mocked(bus.sendText).mockImplementation(async (params) => {
        publishedTags.push(buildBuzzMessageTags(params));
        return "reply-event-1";
      });

      await handleBuzzInbound({
        account: createAccount(),
        cfg: {} satisfies OpenClawConfig,
        bus,
        message: createMessage({
          ...testCase.message,
          mentionedPubkeys: [BOT_PUBLIC_KEY],
        }),
        signal: createSignal(),
      });

      const dispatch = firstDispatch(runtime);
      expect(dispatch.ctxPayload).toMatchObject(testCase.context);

      await dispatch.delivery.deliver({ text: "  " }, { kind: "final" });
      expect(bus.sendText).not.toHaveBeenCalled();

      await dispatch.delivery.deliver({ text: "reply to @Alice" }, { kind: "final" });
      expect(publishedTags).toEqual([
        [
          ["h", ROOM_ID],
          ["e", "event-root", "", "reply"],
        ],
      ]);

      const typing = dispatch.replyPipeline?.typing;
      expect(typing?.keepaliveIntervalMs).toBe(3_000);
      await typing?.start();
      expect(bus.sendTyping).toHaveBeenCalledWith({
        channelId: ROOM_ID,
        threadId: "event-root",
      });
    },
  );

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
      signal: createSignal(),
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
      signal: createSignal(),
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
      signal: createSignal(),
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
