import { describe, expect, it, vi, beforeEach } from "vitest";

import type { MsgContext } from "../auto-reply/templating.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { buildCommandContext, handleCommands } from "../auto-reply/reply/commands.js";
import { parseInlineDirectives } from "../auto-reply/reply/directive-handling.js";
import type { ClawdbotConfig } from "../config/config.js";

// Test that webchat commands work with CommandAuthorized: true
describe("webchat slash commands", () => {
  const workspaceDir = "/tmp/clawdbot-test";

  function buildWebchatParams(commandBody: string, cfg: ClawdbotConfig) {
    const ctx = {
      Body: commandBody,
      BodyForAgent: commandBody,
      BodyForCommands: commandBody,
      RawBody: commandBody,
      CommandBody: commandBody,
      SessionKey: "agent:main:webchat:test",
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
      ChatType: "direct",
      CommandAuthorized: true,
      CommandSource: undefined,
    } as MsgContext;

    const command = buildCommandContext({
      ctx,
      cfg,
      isGroup: false,
      triggerBodyNormalized: commandBody.trim(),
      commandAuthorized: true,
    });

    return {
      ctx,
      cfg,
      command,
      directives: parseInlineDirectives(commandBody),
      elevated: { enabled: true, allowed: true, failures: [] },
      sessionKey: "agent:main:webchat:test",
      workspaceDir,
      defaultGroupActivation: () => "mention" as const,
      resolvedVerboseLevel: "off" as const,
      resolvedReasoningLevel: "off" as const,
      resolveDefaultThinkingLevel: async () => undefined,
      provider: "webchat",
      model: "test-model",
      contextTokens: 0,
      isGroup: false,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("/status returns a reply and does not continue to agent", async () => {
    const cfg = {} as ClawdbotConfig;
    const params = buildWebchatParams("/status", cfg);

    console.log("Command context:", {
      commandBodyNormalized: params.command.commandBodyNormalized,
      isAuthorizedSender: params.command.isAuthorizedSender,
      surface: params.command.surface,
    });

    const result = await handleCommands(params);

    console.log("Result:", {
      shouldContinue: result.shouldContinue,
      hasReply: Boolean(result.reply),
      replyPreview: result.reply?.text?.slice(0, 100),
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeDefined();
    expect(result.reply?.text).toContain("Clawdbot");
  });

  it("/help returns a reply and does not continue to agent", async () => {
    const cfg = {} as ClawdbotConfig;
    const params = buildWebchatParams("/help", cfg);

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeDefined();
    expect(result.reply?.text).toContain("Help");
  });

  it("/new continues to agent (session reset)", async () => {
    const cfg = {} as ClawdbotConfig;
    const params = buildWebchatParams("/new", cfg);

    const result = await handleCommands(params);

    // /new triggers session reset but continues to agent for greeting
    expect(result.shouldContinue).toBe(true);
  });

  it("commands work with commands.text: false (webchat is not native)", async () => {
    const cfg = { commands: { text: false } } as ClawdbotConfig;
    const params = buildWebchatParams("/status", cfg);

    const result = await handleCommands(params);

    // Even with commands.text: false, webchat should still handle commands
    // because webchat doesn't have native command support
    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeDefined();
  });

  it("verifies isAuthorizedSender is true for webchat", async () => {
    const cfg = {} as ClawdbotConfig;
    const params = buildWebchatParams("/status", cfg);

    expect(params.command.isAuthorizedSender).toBe(true);
    expect(params.command.surface).toBe(INTERNAL_MESSAGE_CHANNEL);
  });
});
