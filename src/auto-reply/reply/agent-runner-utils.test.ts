// Tests agent runner utility decisions for fallbacks, channels, and reasoning tags.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveEffectiveModelFallbacksMock = vi.fn();
  const getChannelPluginMock = vi.fn();
  const isReasoningTagProviderMock = vi.fn();
  return { resolveEffectiveModelFallbacksMock, getChannelPluginMock, isReasoningTagProviderMock };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveEffectiveModelFallbacks: (...args: unknown[]) =>
    hoisted.resolveEffectiveModelFallbacksMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => hoisted.getChannelPluginMock(...args),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (...args: unknown[]) => hoisted.isReasoningTagProviderMock(...args),
}));

const {
  buildThreadingToolContext,
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunExecutionParams,
  resolveModelFallbackOptions,
  resolveProviderScopedAuthProfile,
} = await import("./agent-runner-utils.js");

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config: { models: { providers: {} } },
    provider: "openai",
    model: "gpt-4.1",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "none",
    execOverrides: {},
    bashElevated: false,
    timeoutMs: 60_000,
    ...overrides,
  } as unknown as FollowupRun["run"];
}

describe("agent-runner-utils", () => {
  beforeEach(() => {
    hoisted.resolveEffectiveModelFallbacksMock.mockClear();
    hoisted.getChannelPluginMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReturnValue(false);
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({ hasSessionModelOverride: true, modelOverrideSource: "user" });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
      hasAutoFallbackProvenance: false,
    });
    expect(resolved).toEqual({
      cfg: run.config,
      provider: run.provider,
      model: run.model,
      agentDir: run.agentDir,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      fallbacksOverride: ["fallback-model"],
    });
  });

  it("passes through recovered auto fallback provenance for model fallback options", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({
      hasSessionModelOverride: true,
      hasAutoFallbackProvenance: true,
    });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: true,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: true,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("passes through missing agentId for helper-based fallback resolution", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({ agentId: undefined });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: undefined,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: false,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("builds embedded run base params with auth profile and run metadata", () => {
    const run = makeRun({
      enforceFinalTag: true,
      cwd: "/tmp/task-repo",
      taskSuggestionDeliveryMode: "gateway",
    });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
    });

    const resolved = buildEmbeddedRunBaseParams({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      promptCacheKey: "webchat-cache-key",
      authProfile,
    });

    expect(resolved.sessionFile).toBe(run.sessionFile);
    expect(resolved.workspaceDir).toBe(run.workspaceDir);
    expect(resolved.cwd).toBe("/tmp/task-repo");
    expect(resolved.agentDir).toBe(run.agentDir);
    expect(resolved.config).toBe(run.config);
    expect(resolved.skillsSnapshot).toBe(run.skillsSnapshot);
    expect(resolved.ownerNumbers).toBe(run.ownerNumbers);
    expect(resolved.enforceFinalTag).toBe(true);
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-4.1-mini");
    expect(resolved.authProfileId).toBe("profile-openai");
    expect(resolved.authProfileIdSource).toBe("user");
    expect(resolved.thinkLevel).toBe(run.thinkLevel);
    expect(resolved.verboseLevel).toBe(run.verboseLevel);
    expect(resolved.reasoningLevel).toBe(run.reasoningLevel);
    expect(resolved.execOverrides).toBe(run.execOverrides);
    expect(resolved.bashElevated).toBe(run.bashElevated);
    expect(resolved.timeoutMs).toBe(run.timeoutMs);
    expect(resolved.runId).toBe("run-1");
    expect(resolved.promptCacheKey).toBe("webchat-cache-key");
    expect(resolved.taskSuggestionDeliveryMode).toBe("gateway");
  });

  it("threads prompt cache affinity through embedded execution params", () => {
    const run = makeRun();

    const resolved = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: { Provider: "webchat" },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      promptCacheKey: "stable-session-cache-key",
    });

    expect(resolved.runBaseParams.runId).toBe("run-1");
    expect(resolved.runBaseParams.promptCacheKey).toBe("stable-session-cache-key");
  });

  it("uses session chat type over stale queued metadata for embedded execution params", () => {
    const run = makeRun({ chatType: "direct" });

    const resolved = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: { Provider: "discord", ChatType: "Channel" },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
    });

    expect(resolved.embeddedContext.chatType).toBe("channel");
    expect("chatType" in resolved.runBaseParams).toBe(false);
  });

  it("passes through recovered auto fallback provenance for embedded run params", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({
      hasSessionModelOverride: true,
      hasAutoFallbackProvenance: true,
    });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
    });

    const resolved = buildEmbeddedRunBaseParams({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile,
    });

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: true,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: true,
    });
    expect(resolved.modelFallbacksOverride).toEqual(["fallback-model"]);
  });

  it("does not force final-tag enforcement for minimax providers", () => {
    const run = makeRun({ enforceFinalTag: false });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "minimax",
      primaryProvider: "minimax",
    });

    const resolved = buildEmbeddedRunBaseParams({
      run,
      provider: "minimax",
      model: "MiniMax-M2.7",
      runId: "run-1",
      authProfile,
    });

    expect(resolved.enforceFinalTag).toBe(false);
    expect(hoisted.isReasoningTagProviderMock).toHaveBeenCalledWith("minimax", {
      config: run.config,
      workspaceDir: run.workspaceDir,
      modelId: "MiniMax-M2.7",
    });
  });

  it("builds embedded contexts and scopes auth profile by provider", () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
      chatType: "direct",
    });

    const resolved = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "OpenAI",
        To: "channel-1",
        ChatType: "Channel",
        NativeChannelId: "native-chat-1",
        SenderId: "sender-1",
        ChannelContext: {
          sender: { id: "sender-1", providerUserId: "provider-user-1" },
          chat: { id: "native-chat-1", topicId: "topic-1" },
        },
        MemberRoleIds: ["admin", " ", "operator"],
      },
      hasRepliedRef: undefined,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      runId: "run-1",
    });

    expect(resolved.runBaseParams.authProfileId).toBeUndefined();
    expect(resolved.runBaseParams.authProfileIdSource).toBeUndefined();
    expect(resolved.embeddedContext.sessionId).toBe(run.sessionId);
    expect(resolved.embeddedContext.sessionKey).toBe(run.sessionKey);
    expect(resolved.embeddedContext.agentId).toBe(run.agentId);
    expect(resolved.embeddedContext.messageProvider).toBe("openai");
    expect(resolved.embeddedContext.chatType).toBe("channel");
    expect(resolved.embeddedContext.messageTo).toBe("channel-1");
    expect(resolved.embeddedContext.chatId).toBe("native-chat-1");
    expect(resolved.embeddedContext.memberRoleIds).toEqual(["admin", "operator"]);
    expect(resolved.embeddedContext.currentInboundAudio).toBe(false);
    expect(resolved.senderContext).toEqual({
      senderId: "sender-1",
      channelContext: {
        sender: { id: "sender-1", providerUserId: "provider-user-1" },
        chat: { id: "native-chat-1", topicId: "topic-1" },
      },
      senderName: undefined,
      senderUsername: undefined,
      senderE164: undefined,
    });
  });

  it("prefers OriginatingChannel over Provider for messageProvider", () => {
    const run = makeRun({ agentAccountId: "work", chatType: "group" });

    const resolved = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "heartbeat",
        OriginatingChannel: "Telegram",
        OriginatingTo: "268300329",
      },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("telegram");
    expect(resolved.embeddedContext.agentAccountId).toBe("work");
    expect(resolved.embeddedContext.chatType).toBe("group");
    expect(resolved.embeddedContext.messageTo).toBe("268300329");
  });

  it("hydrates the queued route before resolving channel threading policy", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          accountId,
          context,
        }: {
          accountId?: string | null;
          context: { ChatType?: string; NativeChannelId?: string; To?: string };
        }) => ({
          currentChannelId: context.NativeChannelId ?? context.To,
          currentMessagingTarget: context.To,
          replyToMode: accountId === "work" && context.ChatType === "direct" ? "off" : "all",
        }),
      },
    });
    const run = makeRun({ agentAccountId: "work", chatType: "direct" });

    const resolved = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "cron-event",
        NativeChannelId: "D1",
      },
      replyRoute: {
        originatingChannel: "slack",
        originatingTo: "user:U1",
        originatingAccountId: "work",
        originatingChatType: "direct",
      },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("slack");
    expect(resolved.embeddedContext.messageTo).toBe("user:U1");
    expect(resolved.embeddedContext.currentChannelId).toBe("D1");
    expect(resolved.embeddedContext.currentMessagingTarget).toBe("user:U1");
    expect(resolved.embeddedContext.agentAccountId).toBe("work");
    expect(resolved.embeddedContext.chatType).toBe("direct");
    expect(resolved.embeddedContext.replyToMode).toBe("off");
  });

  it("carries inbound audio context into embedded message tools", () => {
    const run = makeRun();

    const resolved = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "telegram",
        To: "268300329",
        MediaType: "audio/ogg; codecs=opus",
        BodyForCommands: "<media:audio>",
      },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
    });

    expect(resolved.embeddedContext.currentInboundAudio).toBe(true);
  });

  it("uses telegram plugin threading context for native commands", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          context,
          hasRepliedRef,
        }: {
          context: { To?: string; MessageThreadId?: string | number };
          hasRepliedRef?: { value: boolean };
        }) => ({
          currentChannelId: context.To?.trim() || undefined,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          hasRepliedRef,
        }),
      },
    });

    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "telegram",
        To: "slash:8460800771",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622",
        MessageThreadId: 928,
        MessageSid: "2284",
      },
      config: { channels: { telegram: { allowFrom: ["*"] } } },
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("telegram:-1003841603622");
    expect(context.currentThreadTs).toBe("928");
    expect(context.currentMessageId).toBe("2284");
  });

  it("uses OriginatingTo for threading tool context on discord native commands", () => {
    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "discord",
        To: "slash:1177378744822943744",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:123456789012345678",
        MessageSid: "msg-9",
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("channel:123456789012345678");
    expect(context.currentMessageId).toBe("msg-9");
  });

  it("does not expose restart-sentinel synthetic ids as message-tool reply targets", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          context,
        }: {
          context: { To?: string; MessageThreadId?: string | number };
        }) => ({
          currentChannelId: context.To,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
        }),
      },
    });

    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622:topic:928",
        MessageThreadId: 928,
        MessageSid: "restart-sentinel:agent:main:telegram:agentTurn:123",
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "telegram",
          sourceTool: "restart-sentinel",
        },
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("telegram:-1003841603622:topic:928");
    expect(context.currentThreadTs).toBe("928");
    expect(context.currentMessageId).toBeUndefined();
  });

  it("uses restart-sentinel reply target when one exists", () => {
    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "whatsapp:+15550002",
        ReplyToId: "provider-reply-id",
        MessageSid: "restart-sentinel:agent:main:whatsapp:agentTurn:123",
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "whatsapp",
          sourceTool: "restart-sentinel",
        },
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("whatsapp:+15550002");
    expect(context.currentMessageId).toBe("provider-reply-id");
  });
});
