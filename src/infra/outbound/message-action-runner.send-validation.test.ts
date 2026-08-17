// Covers send validation for target/channel mismatches, configured channel
// availability, and explicit target requirements.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  forumTestPlugin,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-support.js";

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
    const failure = runMessageAction({
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
    });
    await expect(failure).rejects.toBeInstanceOf(MessageActionDeniedError);
    await expect(failure).rejects.toMatchObject({
      reasonCode: "message_target_missing",
      policyRef: "message-target:required",
    });
  });

  it("types disabled broadcast as an outcome-owning policy denial", async () => {
    const failure = runMessageAction({
      cfg: { tools: { message: { broadcast: { enabled: false } } } } as OpenClawConfig,
      action: "broadcast",
      params: { targets: ["qa-channel:direct:one"], message: "hello" },
    });
    await expect(failure).rejects.toBeInstanceOf(MessageActionDeniedError);
    await expect(failure).rejects.toMatchObject({
      reasonCode: "message_broadcast_disabled",
      policyRef: "message-broadcast:enabled",
    });
  });

  it("preserves the missing-target user-facing error", async () => {
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
});
