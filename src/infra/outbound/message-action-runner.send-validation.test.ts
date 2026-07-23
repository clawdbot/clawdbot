// Covers send validation for target/channel mismatches, configured channel
// availability, and explicit target requirements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  directOutbound,
  forumTestPlugin,
  runDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-helpers.js";

const emptyConfig = {} as OpenClawConfig;
const portableLocation = { latitude: 48.858844, longitude: 2.294351 };
const normalizedSendPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
  }),
  outbound: directOutbound,
  messaging: {
    normalizeTarget: (raw: string) => raw.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw: string) => Boolean(raw.trim()),
      hint: "<chat_id>",
    },
  },
  actions: {
    describeMessageTool: () => ({ actions: ["send"] as const }),
  },
};
const normalizedSendConfig = {
  channels: { telegram: { enabled: true } },
} as OpenClawConfig;

describe("runMessageAction send validation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspaceTestPlugin,
        },
        {
          pluginId: "forum",
          source: "test",
          plugin: forumTestPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: normalizedSendPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("allows send when only presentation payloads are provided", async () => {
    const result = await runDrySend({
      cfg: {
        channels: {
          forum: {
            botToken: "forum-test",
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "forum",
        target: "123456",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only generic presentation blocks are provided", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        presentation: { blocks: [{ type: "divider" }] },
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only a portable location is provided", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        location: { latitude: 48.858844, longitude: 2.294351 },
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    { name: "text", extra: { message: "caption" } },
    { name: "media", extra: { mediaUrl: "https://example.com/photo.jpg" } },
  ])(
    "rejects location sends mixed with $name before cross-context decoration",
    async ({ extra }) => {
      await expect(
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "channel:C99999999",
            location: { latitude: 48.858844, longitude: 2.294351 },
            ...extra,
          },
          toolContext: {
            currentChannelId: "C12345678",
            currentChannelProvider: "workspace",
          },
        }),
      ).rejects.toThrow(/cannot be combined/i);
    },
  );

  it.each([
    { name: "text", content: { message: "hello" } },
    { name: "buffer media", content: { buffer: "aGVsbG8=", filename: "hello.txt" } },
  ])("repairs incidental location for model-authored $name sends", async ({ content }) => {
    const result = await runMessageAction({
      cfg: normalizedSendConfig,
      action: "send",
      actionOrigin: "message-tool",
      params: {
        channel: "telegram",
        target: "123",
        ...content,
        location: portableLocation,
      },
      dryRun: true,
    });

    expect(result).toMatchObject({ kind: "send", action: "send" });
  });

  it("uses the current internal UI source as the message-tool-only send sink", async () => {
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: {
        message: "hello from codex",
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "webchat",
      to: "current-run",
      handledBy: "internal-source",
      dryRun: false,
      payload: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "hello from codex",
        },
      },
    });
    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.toolResult?.content).toEqual([
      {
        type: "text",
        text: "Sent visible reply to the current source conversation via internal-ui.",
      },
    ]);
    expect(result.toolResult?.details).toEqual({
      status: "ok",
      deliveryStatus: "sent",
      channel: "webchat",
      target: "current-run",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplySink: "internal-ui",
      sourceReply: {
        text: "hello from codex",
      },
      message: "hello from codex",
      dryRun: false,
    });
    expect(JSON.stringify(result.toolResult?.content)).not.toContain("hello from codex");
  });

  it.each(["agent:voice:agent:channel:room", "agent:main:telegram::group:room"])(
    "keeps malformed session route %s on the internal source sink",
    async (sessionKey) => {
      const result = await runMessageAction({
        cfg: emptyConfig,
        action: "send",
        params: { message: "private reply" },
        toolContext: { currentChannelProvider: "webchat" },
        sessionKey,
        sourceReplyDeliveryMode: "message_tool_only",
      });

      expect(result).toMatchObject({
        kind: "send",
        channel: "webchat",
        to: "current-run",
        handledBy: "internal-source",
      });
    },
  );

  it("uses non-webchat current source context as the message-tool-only send sink", async () => {
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: {
        message: "telegram reply",
      },
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "user:123456789",
        currentMessageId: 98765,
      },
      sessionKey: "agent:main:telegram:direct:123456789",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "webchat",
      to: "current-run",
      handledBy: "internal-source",
      payload: {
        status: "ok",
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReply: {
          text: "telegram reply",
        },
      },
    });
  });

  it("requires source address context before inferring non-webchat source sinks", async () => {
    await expect(
      runMessageAction({
        cfg: emptyConfig,
        action: "send",
        params: {
          message: "telegram reply",
        },
        toolContext: {
          currentChannelProvider: "telegram",
        },
        sessionKey: "agent:main:telegram:direct:123456789",
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    ).rejects.toThrow(/requires a target/i);
  });

  it("strips unsupported citation control markers from internal UI source replies", async () => {
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: {
        message: "v2026.5.20 release note citeturn2view0",
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      payload: {
        sourceReply: {
          text: "v2026.5.20 release note",
        },
      },
    });
    expect(JSON.stringify(result.payload)).not.toContain("turn2view0");
  });

  it("does not infer an internal UI sink outside message-tool-only source delivery", async () => {
    await expect(
      runMessageAction({
        cfg: emptyConfig,
        action: "send",
        params: {
          message: "hello from codex",
        },
        toolContext: {
          currentChannelProvider: "webchat",
        },
        sessionKey: "agent:main",
        sourceReplyDeliveryMode: "automatic",
      }),
    ).rejects.toThrow(/requires a target/i);
  });

  it("does not treat broadcast targets as a send target", async () => {
    await expect(
      runMessageAction({
        cfg: emptyConfig,
        action: "send",
        params: {
          action: "send",
          idempotencyKey: "run:message:1",
          targets: ["user:123456789"],
          message: "hello from codex",
        },
      }),
    ).rejects.toThrow(/requires a target/i);
  });

  it("keeps explicit message routes on the normal outbound path", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        channel: "workspace",
        target: "#C12345678",
        message: "hello from codex",
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      handledBy: "core",
      dryRun: true,
    });
  });

  it("strips unsupported citation control markers from normal channel sends", async () => {
    const sentText: string[] = [];
    const sendText: NonNullable<
      NonNullable<typeof workspaceTestPlugin.outbound>["sendText"]
    > = async (ctx) => {
      sentText.push(ctx.text);
      return { channel: "workspace", messageId: "workspace-test-message" };
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: {
            ...workspaceTestPlugin,
            outbound: {
              ...workspaceTestPlugin.outbound,
              sendText,
            },
          },
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        channel: "workspace",
        target: "#C12345678",
        message: "v2026.5.20 release note citeturn2view0",
      },
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
    });
    expect(sentText).toEqual(["v2026.5.20 release note"]);
    expect(JSON.stringify(result.payload)).not.toContain("turn2view0");
  });

  it("rejects message sends whose body is only leaked plain-text tool calls", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          message: '[tool:read] {"path":"/app/skills/meme-maker/SKILL.md"}',
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/send requires text or media/i);
  });

  it.each([
    {
      name: "structured poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
      },
    },
    {
      name: "snake_case content poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        poll_question: "Ready?",
        poll_option: ["Yes", "No"],
        poll_public: "true",
      },
    },
    {
      name: "channel-extra poll params with content",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
        pollDurationSeconds: -5,
        pollPublic: "true",
      },
    },
  ])("rejects send actions that include $name", async ({ actionParams }) => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams,
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });

  it("allows send when only schema-padded shared poll modifiers are present", async () => {
    // LLMs routinely echo the shared `message` tool schema's poll modifier
    // defaults (`pollDurationHours: 1`, `pollMulti: false`) on every plain
    // `send` call alongside the rest of the schema-padded slots. Without a
    // pollQuestion or pollOption present, these defaults are noise — not
    // poll intent — and must not block the send.
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hello",
        pollQuestion: "",
        pollOption: [],
        pollDurationHours: 1,
        pollMulti: false,
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only schema-padded channel-extra poll metadata is present", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hello",
        pollDurationSeconds: 60,
        pollPublic: true,
        pollAnonymous: false,
        pollOptionIndex: 0,
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it.each(["", " \t\n"])(
    "treats blank shared-schema event location %j as omitted on send",
    async (location) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          message: "hello",
          location,
        },
        toolContext: { currentChannelId: "C12345678" },
      });

      expect(result.kind).toBe("send");
    },
  );

  it("keeps rejecting a non-empty event location string on send", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          message: "hello",
          location: "Main stage",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow("location must be an object");
  });
});

describe("message body alias normalization", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspaceTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.restoreAllMocks();
  });

  it.each([
    { alias: "SendMessage", value: "hello from alias" },
    { alias: "content", value: "hello from content" },
    { alias: "text", value: "hello from text" },
  ])("normalizes $alias alias to message for send", async ({ alias, value }) => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        [alias]: value,
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("does not overwrite an explicit message with an alias", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "explicit",
        SendMessage: "alias value",
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("emits a diagnostic warning when normalizing an alias", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        SendMessage: "alias body",
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[message-tool] normalized alias "SendMessage" to "message"'),
    );
  });

  it.each([
    {
      name: "reasoning tag",
      SendMessage: "<think>internal reasoning</think>Visible answer",
    },
    {
      name: "formatted reasoning prefix",
      SendMessage: "Reasoning:\n_internal plan_\n\nVisible answer",
    },
  ])("sanitizes SendMessage alias $name before delivery", async ({ SendMessage }) => {
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: {
        SendMessage,
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      payload: {
        sourceReply: {
          text: "Visible answer",
        },
      },
    });
  });

  it("still rejects send with no message and no alias", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });
});
