// Tests agent runner utility decisions for fallbacks, channels, and reasoning tags.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveModelFallbackAvailabilityMock = vi.fn();
  const getChannelPluginMock = vi.fn();
  const isReasoningTagProviderMock = vi.fn();
  return {
    resolveModelFallbackAvailabilityMock,
    getChannelPluginMock,
    isReasoningTagProviderMock,
  };
});

vi.mock("../../agents/agent-scope.js", async () => ({
  modelFallbackOverrideFromAvailability: (
    await vi.importActual<typeof import("../../agents/agent-scope.js")>(
      "../../agents/agent-scope.js",
    )
  ).modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability: (...args: unknown[]) =>
    hoisted.resolveModelFallbackAvailabilityMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => hoisted.getChannelPluginMock(...args),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (...args: unknown[]) => hoisted.isReasoningTagProviderMock(...args),
}));

const { buildThreadingToolContext, buildEmbeddedRunExecutionParams, resolveModelFallbackOptions } =
  await import("./agent-runner-utils.js");
const { resolveProviderScopedAuthProfile } = await import("./agent-runner-auth-profile.js");
const { buildEmbeddedRunBaseParams: buildEmbeddedRunBaseParamsCore } =
  await import("./agent-runner-run-params.js");
const { setChannelSourceTurnId } = await import("./source-turn-id.js");

function buildEmbeddedRunBaseParams(
  params: Omit<Parameters<typeof buildEmbeddedRunBaseParamsCore>[0], "isReasoningTagProvider">,
) {
  return buildEmbeddedRunBaseParamsCore({
    ...params,
    isReasoningTagProvider: hoisted.isReasoningTagProviderMock,
  });
}

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config: { models: { providers: {} } },
    provider: "openai",
    model: "gpt-4.1",
    requestedRouteResolution: "resolved",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkingCatalog: [
      { provider: "openai", id: "gpt-4.1-mini", input: ["text"] },
      { provider: "minimax", id: "MiniMax-M2.7", input: ["text"] },
      { provider: "anthropic", id: "claude-sonnet-4-6", input: ["text"] },
    ],
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
    hoisted.resolveModelFallbackAvailabilityMock.mockReset();
    hoisted.resolveModelFallbackAvailabilityMock.mockReturnValue({ kind: "none_configured" });
    hoisted.getChannelPluginMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReturnValue(false);
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveModelFallbackAvailabilityMock.mockReturnValue({
      kind: "active",
      models: ["fallback-model"],
    });
    const run = makeRun({ hasSessionModelOverride: true, modelOverrideSource: "user" });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveModelFallbackAvailabilityMock).toHaveBeenCalledWith({
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
      requestedRouteResolution: "resolved",
      agentDir: run.agentDir,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      modelFallbackAvailability: { kind: "active", models: ["fallback-model"] },
      fallbacksOverride: ["fallback-model"],
    });
  });

  it("passes through recovered auto fallback provenance for model fallback options", () => {
    hoisted.resolveModelFallbackAvailabilityMock.mockReturnValue({
      kind: "active",
      models: ["fallback-model"],
    });
    const run = makeRun({
      hasSessionModelOverride: true,
      hasAutoFallbackProvenance: true,
    });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveModelFallbackAvailabilityMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: true,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: true,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("disables model fallback options for a model-locked run", () => {
    const run = makeRun({ modelSelectionLocked: true });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveModelFallbackAvailabilityMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: false,
      modelSelectionLocked: true,
    });
    expect(resolved.fallbacksOverride).toEqual([]);
  });

  it("passes through missing agentId for helper-based fallback resolution", () => {
    hoisted.resolveModelFallbackAvailabilityMock.mockReturnValue({
      kind: "active",
      models: ["fallback-model"],
    });
    const run = makeRun({ agentId: undefined });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveModelFallbackAvailabilityMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: undefined,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: false,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("builds embedded run base params with auth profile and run metadata", async () => {
    const run = makeRun({
      enforceFinalTag: true,
      cwd: "/tmp/task-repo",
      taskSuggestionDeliveryMode: "gateway",
      terminalReplyExpectation: "optional",
      trustedInternalHandoff: {
        kind: "subagent-completion",
        sourceSessionKey: "agent:child",
        targetSessionKey: "agent:parent",
        targetSessionId: "session-1",
        provider: "openai",
        model: "gpt-5.6-luna",
      },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      runtimePluginToolGrant: {
        pluginId: "workboard",
        toolNames: ["workboard_complete"],
      },
    });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
    });

    const resolved = await buildEmbeddedRunBaseParams({
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
    expect(resolved.trustedInternalHandoff).toBe(run.trustedInternalHandoff);
    expect(resolved.scheduledToolPolicy).toBe(run.scheduledToolPolicy);
    expect(resolved.runtimePluginToolGrant).toBe(run.runtimePluginToolGrant);
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
    expect(resolved.terminalReplyExpectation).toBe("optional");
  });

  it("threads prompt cache affinity through embedded execution params", async () => {
    const run = makeRun();

    const resolved = await buildEmbeddedRunExecutionParams({
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

  it("uses the queued conversation policy snapshot", async () => {
    const run = makeRun({ conversationToolPolicy: { deny: ["exec"] } });

    const resolved = await buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "telegram",
        ConversationToolPolicy: { deny: ["write"] },
      },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
    });

    expect(resolved.runBaseParams.conversationToolPolicy).toEqual({ deny: ["exec"] });
  });

  it("uses session chat type over stale queued metadata for embedded execution params", async () => {
    const run = makeRun({ chatType: "direct" });

    const resolved = await buildEmbeddedRunExecutionParams({
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

  it("passes through recovered auto fallback provenance for embedded run params", async () => {
    hoisted.resolveModelFallbackAvailabilityMock.mockReturnValue({
      kind: "active",
      models: ["fallback-model"],
    });
    const run = makeRun({
      hasSessionModelOverride: true,
      hasAutoFallbackProvenance: true,
    });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
    });

    const resolved = await buildEmbeddedRunBaseParams({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile,
    });

    expect(hoisted.resolveModelFallbackAvailabilityMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: true,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: true,
    });
    expect(resolved.modelFallbackAvailability).toEqual({
      kind: "active",
      models: ["fallback-model"],
    });
    expect(resolved.modelFallbacksOverride).toEqual(["fallback-model"]);
  });

  it("disables embedded model fallbacks for a model-locked run", async () => {
    const run = makeRun({ modelSelectionLocked: true });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
    });

    const resolved = await buildEmbeddedRunBaseParams({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile,
    });

    expect(hoisted.resolveModelFallbackAvailabilityMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
      hasAutoFallbackProvenance: false,
      modelSelectionLocked: true,
    });
    expect(resolved.modelFallbacksOverride).toEqual([]);
    expect(resolved.modelSelectionLocked).toBe(true);
  });

  it("does not force final-tag enforcement for minimax providers", async () => {
    const run = makeRun({ enforceFinalTag: false });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "minimax",
      primaryProvider: "minimax",
    });

    const resolved = await buildEmbeddedRunBaseParams({
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

  it("builds embedded contexts and scopes auth profile by provider", async () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
      chatType: "direct",
    });

    const resolved = await buildEmbeddedRunExecutionParams({
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

  it("prefers OriginatingChannel over Provider for messageProvider", async () => {
    const run = makeRun({
      agentAccountId: "work",
      chatType: "group",
      conversationRoutePeerId: "queued-peer",
    });

    const resolved = await buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "heartbeat",
        OriginatingChannel: "Telegram",
        OriginatingTo: "268300329",
        ConversationRoutePeerId: "later-peer",
      },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("telegram");
    expect(resolved.embeddedContext.agentAccountId).toBe("work");
    expect(resolved.embeddedContext.chatType).toBe("group");
    expect(resolved.embeddedContext.conversationRoutePeerId).toBe("queued-peer");
    expect(resolved.embeddedContext.messageTo).toBe("268300329");
  });

  it("hydrates the queued route before resolving channel threading policy", async () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          accountId,
          context,
        }: {
          accountId?: string | null;
          context: {
            ChatType?: string;
            MessageThreadId?: string | number;
            NativeChannelId?: string;
            To?: string;
          };
        }) => ({
          currentChannelId: context.NativeChannelId ?? context.To,
          currentMessagingTarget: context.To,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          replyToMode: accountId === "work" && context.ChatType === "direct" ? "off" : "all",
        }),
      },
    });
    const run = makeRun({ agentAccountId: "work", chatType: "direct" });

    const resolved = await buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "cron-event",
        NativeChannelId: "D1",
        SessionKey: "agent:main:main:thread:1234:42",
        MessageThreadId: "stale-topic",
      },
      replyRoute: {
        originatingChannel: "slack",
        originatingTo: "user:U1",
        originatingAccountId: "work",
        originatingChatType: "direct",
        originatingThreadId: 42,
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
    expect(resolved.embeddedContext.messageThreadId).toBe(42);
    expect(resolved.embeddedContext.currentThreadTs).toBe("42");
    expect(resolved.embeddedContext.agentAccountId).toBe("work");
    expect(resolved.embeddedContext.chatType).toBe("direct");
    expect(resolved.embeddedContext.replyToMode).toBe("off");
  });

  it("carries a prepared direct-message reply mode into generic message tools", async () => {
    const run = makeRun();
    const replyRoute = {
      originatingChannel: "reef",
      originatingTo: "reef:remote-agent",
      originatingReplyToMode: "all",
    } satisfies Pick<
      FollowupRun,
      "originatingChannel" | "originatingTo" | "originatingReplyToMode"
    >;

    const resolved = await buildEmbeddedRunExecutionParams({
      run,
      replyRoute,
      sessionCtx: {
        Provider: "reef",
        To: "reef:local-agent",
        MessageSid: "message-1",
      },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
    });

    expect(resolved.embeddedContext).toMatchObject({
      currentChannelId: "reef:remote-agent",
      currentChannelProvider: "reef",
      currentMessageId: "message-1",
      replyToMode: "all",
    });
  });

  it("carries inbound audio context into embedded message tools", async () => {
    const run = makeRun();

    const resolved = await buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "telegram",
        To: "268300329",
        media: [{ contentType: "audio/ogg; codecs=opus", kind: "audio" }],
        BodyForCommands: "",
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
    const sessionCtx = {
      Provider: "discord",
      To: "slash:1177378744822943744",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:123456789012345678",
      MessageSid: "msg-9",
    };
    setChannelSourceTurnId(sessionCtx, "channel-user:v1:source-9");
    const context = buildThreadingToolContext({
      sessionCtx,
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("channel:123456789012345678");
    expect(context.currentMessageId).toBe("msg-9");
    expect(context.currentSourceTurnId).toBe("channel-user:v1:source-9");
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
