// Buzz tests cover inbound room admission, mention gating, and reply delivery.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzBus } from "./buzz-bus.js";
import { handleBuzzInbound } from "./inbound.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_NORMAL_MESSAGE_KIND,
  type BuzzInboundMessage,
} from "./message-event.js";
import { setBuzzRuntime } from "./runtime.js";
import type { ResolvedBuzzAccount } from "./types.js";

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

function createBus(): BuzzBus {
  return {
    publicKey: BOT_PUBLIC_KEY,
    sendText: vi.fn(async () => "reply-event-1"),
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

    await handleBuzzInbound({
      account: createAccount(),
      cfg: {} satisfies OpenClawConfig,
      bus: createBus(),
      message: createMessage({ mentionedPubkeys: [BOT_PUBLIC_KEY] }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    expect(firstDispatch(runtime).ctxPayload).toMatchObject({
      WasMentioned: true,
      SenderId: SENDER_PUBLIC_KEY,
      GroupChannel: ROOM_ID,
      GroupSubject: ROOM_ID,
    });
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
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("preserves Buzz thread and reply identifiers for agent replies", async () => {
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

    await dispatch.delivery.deliver({ text: "threaded reply" }, { kind: "final" });
    expect(bus.sendText).toHaveBeenCalledWith({
      channelId: ROOM_ID,
      text: "threaded reply",
      threadId: "event-root",
      replyToId: "event-reply",
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
