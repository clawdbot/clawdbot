import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  forumTestPlugin,
  runDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-helpers.js";

const emptyConfig = {} as OpenClawConfig;

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
      name: "string-encoded poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: "60",
        pollPublic: "true",
      },
    },
    {
      name: "snake_case poll params",
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
      name: "negative poll duration params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: -5,
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
