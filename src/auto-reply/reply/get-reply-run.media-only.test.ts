import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createReplyOperation } from "./reply-run-registry.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/embedded-agent.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunStreaming: vi.fn().mockReturnValue(false),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn().mockReturnValue(undefined),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
  waitForEmbeddedAgentRunEnd: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../config/sessions/group.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
}));

const storeRuntimeLoads = vi.hoisted(() => vi.fn());
const updateSessionStore = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/store.runtime.js", () => {
  storeRuntimeLoads();
  return {
    updateSessionStore,
  };
});

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock(import("../../routing/session-key.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    normalizeMainKey: () => "main",
    normalizeAgentId: (id: string | undefined | null) => id ?? "default",
  };
});

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.runtime.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

vi.mock("./groups.js", () => ({
  buildDirectChatContext: vi.fn().mockReturnValue(""),
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
  resolveGroupSilentReplyBehavior: vi.fn(
    (params: {
      sessionEntry?: SessionEntry;
      defaultActivation: "always" | "mention";
      silentReplyPolicy?: "allow" | "disallow";
    }) => {
      const activation = params.sessionEntry?.groupActivation ?? params.defaultActivation;
      const canUseSilentReply = params.silentReplyPolicy !== "disallow";
      return {
        activation,
        canUseSilentReply,
        allowEmptyAssistantReplyAsSilent: params.silentReplyPolicy === "allow",
      };
    },
  ),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
  resolveInboundUserContextPromptJoiner: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "steer" }),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("./session-updates.runtime.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
}));

vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

let runPreparedReply: typeof import("./get-reply-run.js").runPreparedReply;
let runReplyAgent: typeof import("./agent-runner.runtime.js").runReplyAgent;
let routeReply: typeof import("./route-reply.runtime.js").routeReply;
let drainFormattedSystemEvents: typeof import("./session-system-events.js").drainFormattedSystemEvents;
let resolveTypingMode: typeof import("./typing-mode.js").resolveTypingMode;
let buildDirectChatContext: typeof import("./groups.js").buildDirectChatContext;
let buildGroupChatContext: typeof import("./groups.js").buildGroupChatContext;
let buildInboundUserContextPrefix: typeof import("./inbound-meta.js").buildInboundUserContextPrefix;
let resolveInboundUserContextPromptJoiner: typeof import("./inbound-meta.js").resolveInboundUserContextPromptJoiner;
let getActiveReplyRunCount: typeof import("./reply-run-registry.js").getActiveReplyRunCount;
let replyRunTesting: typeof import("./reply-run-registry.js").testing;
let loadScopeCounter = 0;

function createGatewayDrainingError(): Error {
  const error = new Error("Gateway is draining for restart; new tasks are not accepted");
  error.name = "GatewayDrainingError";
  return error;
}

async function loadFreshGetReplyRunModuleForTest() {
  return await importFreshModule<typeof import("./get-reply-run.js")>(
    import.meta.url,
    `./get-reply-run.js?scope=media-only-${loadScopeCounter++}`,
  );
}

function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      ThreadHistoryBody: "Earlier message in this thread",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
      ChatType: "group",
    },
    sessionCtx: {
      Body: "",
      BodyStripped: "",
      ThreadHistoryBody: "Earlier message in this thread",
      MediaPath: "/tmp/input.png",
      Provider: "slack",
      ChatType: "group",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      channel: "slack",
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
      rawBodyNormalized: "",
      commandBodyNormalized: "",
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: {
      hasThinkDirective: false,
      thinkLevel: undefined,
    } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
      resolveThinkingCatalog: async () => [],
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    ...overrides,
  };
}

function ownerParams(): Parameters<typeof runPreparedReply>[0] {
  const params = baseParams();
  params.command = {
    ...(params.command as Record<string, unknown>),
    senderIsOwner: true,
  } as never;
  return params;
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

function requireMockCallArg(mock: MockCallSource, label: string, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`${label} call ${index} missing`);
  }
  return call[0];
}

function requireRunReplyAgentCall(index = 0) {
  const call = vi.mocked(runReplyAgent).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`runReplyAgent call ${index} missing`);
  }
  return call;
}

function requireLastRunReplyAgentCall() {
  const calls = vi.mocked(runReplyAgent).mock.calls;
  const call = calls[calls.length - 1]?.[0];
  if (!call) {
    throw new Error("last runReplyAgent call missing");
  }
  return call;
}

describe("runPreparedReply media-only handling", () => {
  const cleanupPaths: string[] = [];

  beforeAll(async () => {
    ({ runPreparedReply } = await import("./get-reply-run.js"));
    ({ runReplyAgent } = await import("./agent-runner.runtime.js"));
    ({ routeReply } = await import("./route-reply.runtime.js"));
    ({ drainFormattedSystemEvents } = await import("./session-system-events.js"));
    ({ resolveTypingMode } = await import("./typing-mode.js"));
    ({ buildDirectChatContext, buildGroupChatContext } = await import("./groups.js"));
    ({ buildInboundUserContextPrefix, resolveInboundUserContextPromptJoiner } =
      await import("./inbound-meta.js"));
    ({ testing: replyRunTesting, getActiveReplyRunCount } =
      await import("./reply-run-registry.js"));
  });

  beforeEach(async () => {
    storeRuntimeLoads.mockClear();
    updateSessionStore.mockReset();
    vi.clearAllMocks();
    replyRunTesting.resetReplyRunRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    const paths = cleanupPaths.splice(0);
    return Promise.all(paths.map((entry) => rm(entry, { recursive: true, force: true })));
  });

  it("does not load session store runtime on module import", async () => {
    await loadFreshGetReplyRunModuleForTest();

    expect(storeRuntimeLoads).not.toHaveBeenCalled();
  });

  it("passes approved elevated defaults to the runner", async () => {
    await runPreparedReply(
      baseParams({
        resolvedElevatedLevel: "on",
        elevatedEnabled: true,
        elevatedAllowed: true,
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.bashElevated).toEqual({
      enabled: true,
      allowed: true,
      defaultLevel: "on",
      fullAccessAvailable: true,
    });
  });

  it("propagates non-visible assistant silence for group runs", async () => {
    await runPreparedReply(baseParams());

    let call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(true);

    await runPreparedReply(
      baseParams({
        defaultActivation: "mention",
      }),
    );

    call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(true);
  });

  it("hydrates runtime thinking metadata before trusting static provider support", async () => {
    const resolveThinkingCatalog = vi.fn(async () => [
      {
        provider: "openai",
        id: "chat-latest",
        reasoning: false,
      },
    ]);

    await runPreparedReply(
      baseParams({
        provider: "openai",
        model: "chat-latest",
        resolvedThinkLevel: "high",
        modelState: {
          resolveDefaultThinkingLevel: async () => "high",
          resolveThinkingCatalog,
          allowedModelCatalog: [
            {
              provider: "openai",
              id: "chat-latest",
              name: "Chat Latest",
            },
          ],
        } as never,
      }),
    );

    expect(resolveThinkingCatalog).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.thinkLevel).toBe("off");
  });

  it("keeps empty-assistant silence disabled for direct runs by default", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier direct message",
          OriginatingChannel: "slack",
          OriginatingTo: "D123",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier direct message",
          MediaPath: "/tmp/input.png",
          Provider: "slack",
          ChatType: "direct",
          OriginatingChannel: "slack",
          OriginatingTo: "D123",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(false);
  });

  it("passes message-tool-only delivery into direct chat prompt context", async () => {
    await runPreparedReply(
      baseParams({
        opts: { sourceReplyDeliveryMode: "message_tool_only" },
        ctx: {
          Body: "yo",
          RawBody: "yo",
          CommandBody: "yo",
          ThreadHistoryBody: "Earlier direct message",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram-direct-test-id",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "yo",
          BodyStripped: "yo",
          ThreadHistoryBody: "Earlier direct message",
          MediaPath: "/tmp/input.png",
          Provider: "telegram",
          ChatType: "direct",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram-direct-test-id",
        },
      }),
    );

    expect(buildDirectChatContext).toHaveBeenCalledTimes(1);
    const directContextParams = requireMockCallArg(
      vi.mocked(buildDirectChatContext),
      "direct chat context",
    ) as {
      sessionCtx?: { Provider?: string; ChatType?: string };
      sourceReplyDeliveryMode?: string;
    };
    expect(directContextParams?.sessionCtx?.Provider).toBe("telegram");
    expect(directContextParams?.sessionCtx?.ChatType).toBe("direct");
    expect(directContextParams?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(buildInboundUserContextPrefix).toHaveBeenCalledWith(
      {
        Body: "yo",
        BodyStripped: "yo",
        ThreadHistoryBody: "Earlier direct message",
        MediaPath: "/tmp/input.png",
        Provider: "telegram",
        ChatType: "direct",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram-direct-test-id",
        InboundHistory: undefined,
        ThreadStarterBody: undefined,
      },
      expect.anything(),
      { sourceReplyDeliveryMode: "message_tool_only" },
    );
  });

  it.each(["direct", "dm"] as const)(
    "does not propagate empty-assistant silence for %s runs",
    async (chatType) => {
      await runPreparedReply(
        baseParams({
          ctx: {
            Body: "",
            RawBody: "",
            CommandBody: "",
            ThreadHistoryBody: "Earlier direct message",
            OriginatingChannel: "slack",
            OriginatingTo: "D123",
            ChatType: chatType,
          },
          sessionCtx: {
            Body: "",
            BodyStripped: "",
            ThreadHistoryBody: "Earlier direct message",
            MediaPath: "/tmp/input.png",
            Provider: "slack",
            ChatType: chatType,
            OriginatingChannel: "slack",
            OriginatingTo: "D123",
          },
          cfg: {
            session: {},
            channels: {},
            agents: {},
          },
        }),
      );

      const call = requireLastRunReplyAgentCall();
      expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(false);
    },
  );

  it("does not borrow target-session silence for native commands sent from direct chats", async () => {
    await runPreparedReply(
      baseParams({
        sessionKey: "agent:main:telegram:group:target",
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier direct message",
          OriginatingChannel: "telegram",
          OriginatingTo: "D123",
          ChatType: "direct",
          CommandSource: "native",
          SessionKey: "agent:main:telegram:direct:source",
          CommandTargetSessionKey: "agent:main:telegram:group:target",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier direct message",
          MediaPath: "/tmp/input.png",
          Provider: "telegram",
          ChatType: "direct",
          OriginatingChannel: "telegram",
          OriginatingTo: "D123",
          CommandSource: "native",
          SessionKey: "agent:main:telegram:direct:source",
          CommandTargetSessionKey: "agent:main:telegram:group:target",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(false);
  });

  it("allows media-only prompts and preserves thread context in queued followups", async () => {
    const result = await runPreparedReply(baseParams());
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call.followupRun.prompt).toContain("Earlier message in this thread");
    expect(call.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it.each([
    "discord",
    "telegram",
    "slack",
    "whatsapp",
    "signal",
    "imessage",
    "matrix",
    "msteams",
    "webchat",
  ] as const)("enables default same-turn steering for active %s runs", async (channel) => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    const params = baseParams({
      sessionKey: `agent:main:${channel}:direct:steer-smoke`,
    });
    params.ctx = {
      ...params.ctx,
      Provider: channel,
      OriginatingChannel: channel,
      OriginatingTo: `${channel}-target`,
      ChatType: "direct",
    } as never;
    params.sessionCtx = {
      ...params.sessionCtx,
      Provider: channel,
      OriginatingChannel: channel,
      OriginatingTo: `${channel}-target`,
      ChatType: "direct",
    } as never;
    params.command = {
      ...(params.command as Record<string, unknown>),
      surface: channel,
      channel,
    } as never;

    await runPreparedReply(params);

    expect(queueSettings.resolveQueueSettings).toHaveBeenCalledWith(
      expect.objectContaining({ channel }),
    );
    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call).toMatchObject({
      shouldSteer: true,
      shouldFollowup: true,
      isActive: true,
      isStreaming: true,
      resolvedQueue: expect.objectContaining({ mode: "steer" }),
    });
    expect(call?.followupRun.run.messageProvider).toBe(channel);
    expect(call?.followupRun.originatingChannel).toBe(channel);
  });

  it("keeps thread history context on follow-up turns", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call.followupRun.prompt).toContain("Earlier message in this thread");
  });

  it("falls back to thread starter context on follow-up turns when history is absent", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadStarterBody: "starter message",
          ThreadHistoryBody: undefined,
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadStarterBody: "starter message",
          ThreadHistoryBody: undefined,
          MediaPath: "/tmp/input.png",
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread starter - for context]");
    expect(call.followupRun.prompt).toContain("starter message");
  });

  it("prefers thread history over thread starter on follow-up turns", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadStarterBody: "starter message",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadStarterBody: "starter message",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call.followupRun.prompt).not.toContain("[Thread starter - for context]");
  });

  it("does not duplicate thread starter text with a plain-text prelude", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Thread starter (untrusted, for context):",
        "```json",
        '{"body":"starter message"}',
        "```",
      ].join("\n"),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadStarterBody: "starter message",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadStarterBody: "starter message",
          MediaPath: "/tmp/input.png",
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.currentInboundContext?.text).toContain(
      "Thread starter (untrusted, for context):",
    );
    expect(call.followupRun.prompt).not.toContain("[Thread starter - for context]");
  });

  it("returns the empty-body reply when there is no text and no media", async () => {
    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "slack",
        },
      }),
    );

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("still skips metadata-only turns when inbound context adds chat_id", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify({ chat_id: "paperclip:issue:abc" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "paperclip",
          OriginatingChannel: "paperclip",
          OriginatingTo: "paperclip:issue:abc",
          ChatType: "direct",
        },
      }),
    );

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("allows pending inbound history to trigger a bare mention turn", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Chat history since last reply (untrusted, for context):",
        "```json",
        JSON.stringify(
          [{ sender: "Alice", timestamp_ms: 1_700_000_000_000, body: "what changed?" }],
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ChatType: "group",
          WasMentioned: true,
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "feishu",
          OriginatingChannel: "feishu",
          OriginatingTo: "chat-1",
          ChatType: "group",
          WasMentioned: true,
          InboundHistory: [
            { sender: "Alice", timestamp: 1_700_000_000_000, body: "what changed?" },
          ],
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.prompt).toBe("");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "Chat history since last reply",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("what changed?");
    expect(call?.followupRun.prompt).not.toContain("[User sent media without caption]");
  });

  it("does not treat blank pending inbound history as user input", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Chat history since last reply (untrusted, for context):",
        "```json",
        JSON.stringify([{ sender: "Alice", timestamp_ms: 1_700_000_000_000, body: "" }], null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ChatType: "group",
          WasMentioned: true,
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "feishu",
          OriginatingChannel: "feishu",
          OriginatingTo: "chat-1",
          ChatType: "group",
          WasMentioned: true,
          InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "\u0000  " }],
        },
      }),
    );

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("allows webchat pure-image turns when image content is carried outside MediaPath", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify({ provider: "webchat", chat_id: "webchat:local" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
        },
        opts: {
          images: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
            },
          ] as never,
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.currentInboundContext?.text).toContain("webchat:local");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("hydrates current image MediaPaths by extension when MediaTypes are missing", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-followup-image-"));
    cleanupPaths.push(tmpDir);
    const imagePath = path.join(tmpDir, "inbound.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "describe this",
          RawBody: "describe this",
          CommandBody: "describe this",
          MediaPaths: [imagePath],
          MediaWorkspaceDir: tmpDir,
          OriginatingChannel: "discord",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "describe this",
          BodyStripped: "describe this",
          Provider: "discord",
          OriginatingChannel: "discord",
          OriginatingTo: "C123",
          ChatType: "group",
          MediaPaths: [imagePath],
          MediaWorkspaceDir: tmpDir,
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.images).toEqual([
      {
        type: "image",
        data: expect.any(String),
        mimeType: "image/png",
      },
    ]);
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "describe this",
      MediaPath: imagePath,
      MediaPaths: [imagePath],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
    expect(call.followupRun.images?.[0]?.data).toHaveLength(92);
    expect(call.followupRun.imageOrder).toEqual(["inline"]);
  });

  it("does not copy prior session media onto text-only followups", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "follow up without media",
          RawBody: "follow up without media",
          CommandBody: "follow up without media",
          OriginatingChannel: "telegram",
          OriginatingTo: "42",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "follow up without media",
          BodyStripped: "follow up without media",
          Provider: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "42",
          ChatType: "direct",
          MediaPath: "/tmp/previous-image.png",
          MediaPaths: ["/tmp/previous-image.png"],
          MediaTypes: ["image/png"],
        },
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "follow up without media",
    });
    expect(call.followupRun.userTurnTranscriptRecorder?.message).not.toHaveProperty("MediaPath");
    expect(call.followupRun.userTurnTranscriptRecorder?.message).not.toHaveProperty("MediaPaths");
  });

  it("does not rehydrate current MediaPaths after image understanding enriched the prompt", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-followup-image-"));
    cleanupPaths.push(tmpDir);
    const imagePath = path.join(tmpDir, "inbound.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const secondImagePath = path.join(tmpDir, "second.png");
    await writeFile(
      secondImagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          RawBody: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          CommandBody: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          MediaPaths: [imagePath, secondImagePath],
          MediaTypes: ["image/png", "image/png"],
          MediaWorkspaceDir: tmpDir,
          MediaUnderstanding: [
            {
              kind: "image.description",
              attachmentIndex: 0,
              provider: "openai",
              model: "gpt-4o",
              text: "a tiny dot image",
            },
            {
              kind: "image.description",
              attachmentIndex: 1,
              provider: "openai",
              model: "gpt-4o",
              text: "another tiny dot image",
            },
          ],
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          BodyStripped: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          Provider: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
          MediaPaths: [imagePath, secondImagePath],
          MediaTypes: ["image/png", "image/png"],
          MediaWorkspaceDir: tmpDir,
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.images).toBeUndefined();
    expect(call.followupRun.imageOrder).toBeUndefined();
    expect(call.followupRun.prompt).toContain("a tiny dot image");
  });

  it("rehydrates only current MediaPaths missing image understanding", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-followup-image-"));
    cleanupPaths.push(tmpDir);
    const imagePath = path.join(tmpDir, "inbound.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const secondImageData = Buffer.from("second image bytes");
    const secondImagePath = path.join(tmpDir, "second.png");
    await writeFile(secondImagePath, secondImageData);

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          RawBody: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          CommandBody: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          MediaPaths: [imagePath, secondImagePath],
          MediaTypes: ["image/png", "image/png"],
          MediaWorkspaceDir: tmpDir,
          MediaUnderstanding: [
            {
              kind: "image.description",
              attachmentIndex: 0,
              provider: "openai",
              model: "gpt-4o",
              text: "a tiny dot image",
            },
          ],
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          BodyStripped: "describe this\n\n[Image]\nDescription:\na tiny dot image",
          Provider: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
          MediaPaths: [imagePath, secondImagePath],
          MediaTypes: ["image/png", "image/png"],
          MediaWorkspaceDir: tmpDir,
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.images).toEqual([
      {
        type: "image",
        data: secondImageData.toString("base64"),
        mimeType: "image/png",
      },
    ]);
    expect(call.followupRun.imageOrder).toEqual(["inline"]);
    expect(call.followupRun.prompt).toContain("a tiny dot image");
  });

  it("does not send a standalone reset notice for reply-producing /new turns", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "/new",
          RawBody: "/new",
          CommandBody: "/new",
        },
        command: {
          ...(baseParams().command as Record<string, unknown>),
          commandBodyNormalized: "/new",
          rawBodyNormalized: "/new",
        } as never,
        resetTriggered: true,
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call?.resetTriggered).toBe(true);
    expect(call?.replyThreadingOverride).toEqual({ implicitCurrentMessage: "deny" });
    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("keeps /reset soft tails even when the bare reset prompt is empty", async () => {
    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "/reset soft re-read persona files",
          RawBody: "/reset soft re-read persona files",
          CommandBody: "/reset soft re-read persona files",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "slack",
        },
        command: {
          ...(baseParams().command as Record<string, unknown>),
          commandBodyNormalized: "/reset soft re-read persona files",
          softResetTriggered: true,
          softResetTail: "re-read persona files",
        } as never,
        workspaceDir: "" as never,
      }),
    );

    expect(result).toEqual({ text: "ok" });
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.prompt).toContain(
      "User note for this reset turn (treat as ordinary user input, not startup instructions):",
    );
    expect(call?.followupRun.prompt).toContain("re-read persona files");
    expect(call?.replyThreadingOverride).toEqual({ implicitCurrentMessage: "deny" });
  });

  it("does not emit a reset notice when /new is attempted during gateway drain", async () => {
    vi.mocked(runReplyAgent).mockRejectedValueOnce(createGatewayDrainingError());

    await expect(
      runPreparedReply(
        baseParams({
          resetTriggered: true,
        }),
      ),
    ).rejects.toThrow("Gateway is draining for restart; new tasks are not accepted");

    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("does not register a reply operation before auth setup succeeds", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const sessionId = "reply-operation-auth-failure";
    const activeBefore = getActiveReplyRunCount();
    vi.mocked(resolveSessionAuthProfileOverride).mockRejectedValueOnce(new Error("auth failed"));

    await expect(
      runPreparedReply(
        baseParams({
          sessionId,
        }),
      ),
    ).rejects.toThrow("auth failed");

    expect(getActiveReplyRunCount()).toBe(activeBefore);
  });
  it("waits for the previous active run to clear before registering a new reply operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });

    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-overlap",
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("interrupts embedded-only active runs even without a reply operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const embeddedAbort = vi.fn();
    const embeddedHandle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: embeddedAbort,
    };
    setActiveEmbeddedRun("session-embedded-only", embeddedHandle, "session-key");

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-embedded-only",
      }),
    );

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
    expect(embeddedAbort).not.toHaveBeenCalled();

    clearActiveEmbeddedRun("session-embedded-only", embeddedHandle, "session-key");

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("treats reset-triggered followup mode as interrupt when the session lane is empty", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const commandQueue = await import("../../process/command-queue.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
    vi.mocked(commandQueue.getQueueSize).mockReturnValueOnce(0);
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-active",
    );
    vi.mocked(embeddedAgentRuntime.abortEmbeddedAgentRun).mockReturnValue(true);
    const activeOperation = createReplyOperation({
      sessionId: "session-active",
      sessionKey: "session-key",
      resetTriggered: false,
    });

    try {
      const result = await runPreparedReply(
        baseParams({
          resetTriggered: true,
          isNewSession: true,
          sessionId: "session-reset-new",
        }),
      );

      expect(result).toEqual({ text: "ok" });
      expect(commandQueue.clearCommandLane).toHaveBeenCalledWith("session:session-key");
      expect(embeddedAgentRuntime.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-active");
      expect(activeOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
      const call = requireRunReplyAgentCall();
      expect(call?.shouldSteer).toBe(false);
      expect(call?.shouldFollowup).toBe(false);
      expect(call?.resetTriggered).toBe(true);
    } finally {
      activeOperation.complete();
    }
  });
  it("does not enable steering for active heartbeat runs", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "followup",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    await runPreparedReply(
      baseParams({
        opts: { isHeartbeat: true },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.shouldSteer).toBe(false);
    expect(call?.shouldFollowup).toBe(true);
    expect(call?.isActive).toBe(true);
    expect(call?.isStreaming).toBe(true);
  });

  it.each([
    ["message thread id", { MessageThreadId: "501.000" }],
    ["transport thread id", { TransportThreadId: "501.000" }],
  ] as const)(
    "queues same-session Slack DM turns instead of steering across Slack threads using %s",
    async (_label, threadContext) => {
      const queueSettings = await import("./queue/settings-runtime.js");
      const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
      vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
        mode: "steer",
        debounceMs: 500,
        cap: 20,
        dropPolicy: "summarize",
      });
      const activeRun = createReplyOperation({
        sessionId: "active-session",
        sessionKey: "session-key",
        resetTriggered: false,
        routeThreadId: "500.000",
      });
      activeRun.setPhase("running");
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReturnValueOnce("active-session")
        .mockReturnValueOnce("active-session");
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

      try {
        await runPreparedReply(
          baseParams({
            isNewSession: false,
            ctx: {
              Body: "second top-level DM",
              RawBody: "second top-level DM",
              CommandBody: "second top-level DM",
              Provider: "slack",
              Surface: "slack",
              ChatType: "direct",
              OriginatingChannel: "slack",
              OriginatingTo: "user:U1",
              ...threadContext,
            },
            sessionCtx: {
              Body: "second top-level DM",
              BodyStripped: "second top-level DM",
              Provider: "slack",
              Surface: "slack",
              ChatType: "direct",
              OriginatingChannel: "slack",
              OriginatingTo: "user:U1",
              ...threadContext,
            },
          }),
        );
      } finally {
        activeRun.complete();
      }

      const call = requireLastRunReplyAgentCall();
      expect(call.shouldSteer).toBe(false);
      expect(call.shouldFollowup).toBe(true);
      expect(call.isActive).toBe(true);
      expect(call.isStreaming).toBe(true);
      expect(call.followupRun.originatingThreadId).toBe("501.000");
    },
  );

  it("keeps non-Slack same-session turns steerable when route threads differ", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    const activeRun = createReplyOperation({
      sessionId: "active-session",
      sessionKey: "session-key",
      resetTriggered: false,
      routeThreadId: 42,
    });
    activeRun.setPhase("running");
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    try {
      await runPreparedReply(
        baseParams({
          isNewSession: false,
          ctx: {
            Body: "follow-up in another transport thread",
            RawBody: "follow-up in another transport thread",
            CommandBody: "follow-up in another transport thread",
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "direct",
            OriginatingChannel: "telegram",
            OriginatingTo: "user:1",
            MessageThreadId: 43,
          },
          sessionCtx: {
            Body: "follow-up in another transport thread",
            BodyStripped: "follow-up in another transport thread",
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "direct",
            OriginatingChannel: "telegram",
            OriginatingTo: "user:1",
            MessageThreadId: 43,
          },
        }),
      );
    } finally {
      activeRun.complete();
    }

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldSteer).toBe(true);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.isStreaming).toBe(true);
    expect(call.followupRun.originatingThreadId).toBe(43);
  });

  it("rechecks same-session ownership after async prep before registering a new reply operation", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");

    let resolveAuth: (() => void) | undefined;
    const authPromise = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });

    vi.mocked(resolveSessionAuthProfileOverride).mockImplementationOnce(
      async () => await authPromise.then(() => undefined),
    );
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-auth-race",
      }),
    );

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    const intruderRun = createReplyOperation({
      sessionId: "session-auth-race",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    intruderRun.setPhase("running");
    if (!resolveAuth) {
      throw new Error("Expected auth profile resolver to be initialized");
    }
    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    intruderRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });

  it("does not queue a run behind its provided pre-dispatch reply operation", async () => {
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const operation = createReplyOperation({
      sessionId: "session-pre-dispatch-owner",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-pre-dispatch-owner",
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValue(true);

    try {
      await expect(
        runPreparedReply(
          baseParams({
            isNewSession: false,
            sessionId: "session-pre-dispatch-owner",
            opts: { replyOperation: operation } as never,
          }),
        ),
      ).resolves.toEqual({ text: "ok" });

      const call = requireLastRunReplyAgentCall();
      expect(call.replyOperation).toBe(operation);
      expect(vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive)).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
    }
  });

  it("does not interrupt its provided pre-dispatch reply operation for reset turns", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const commandQueue = await import("../../process/command-queue.js");
    const operation = createReplyOperation({
      sessionId: "session-reset-owner",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
    vi.mocked(commandQueue.getQueueSize).mockReturnValueOnce(0);
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-reset-owner",
    );

    try {
      await expect(
        runPreparedReply(
          baseParams({
            resetTriggered: true,
            isNewSession: true,
            sessionId: "session-reset-owner",
            opts: { replyOperation: operation } as never,
          }),
        ),
      ).resolves.toEqual({ text: "ok" });

      const call = requireLastRunReplyAgentCall();
      expect(call.replyOperation).toBe(operation);
      expect(commandQueue.clearCommandLane).not.toHaveBeenCalled();
      expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
    }
  });

  it("re-resolves auth profile after waiting for a prior run", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "session-auth-profile",
        sessionFile: "/tmp/session-auth-profile.jsonl",
        authProfileOverride: "profile-before-wait",
        authProfileOverrideSource: "auto",
        updatedAt: 1,
      },
    };
    vi.mocked(resolveSessionAuthProfileOverride).mockImplementation(async ({ sessionEntry }) => {
      return sessionEntry?.authProfileOverride;
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const previousRun = createReplyOperation({
      sessionId: "session-auth-profile",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-auth-profile",
        sessionEntry: sessionStore["session-key"],
        sessionStore,
      }),
    );

    await Promise.resolve();
    sessionStore["session-key"] = {
      ...sessionStore["session-key"],
      authProfileOverride: "profile-after-wait",
      authProfileOverrideSource: "auto",
      updatedAt: 2,
    };
    previousRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.authProfileId).toBe("profile-after-wait");
    expect(vi.mocked(resolveSessionAuthProfileOverride)).toHaveBeenCalledTimes(1);
  });

  it("re-resolves same-session ownership after session-id rotation during async prep", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");

    let resolveAuth: (() => void) | undefined;
    const authPromise = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "session-before-rotation",
        sessionFile: "/tmp/session-before-rotation.jsonl",
        updatedAt: 1,
      },
    };

    vi.mocked(resolveSessionAuthProfileOverride).mockImplementationOnce(
      async () => await authPromise.then(() => undefined),
    );
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-before-rotation",
        sessionEntry: sessionStore["session-key"],
        sessionStore,
      }),
    );

    await Promise.resolve();
    const rotatedRun = createReplyOperation({
      sessionId: "session-before-rotation",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    rotatedRun.setPhase("running");
    sessionStore["session-key"] = {
      ...sessionStore["session-key"],
      sessionId: "session-after-rotation",
      sessionFile: "/tmp/session-after-rotation.jsonl",
      updatedAt: 2,
    };
    rotatedRun.updateSessionId("session-after-rotation");

    if (!resolveAuth) {
      throw new Error("Expected auth profile resolver to be initialized");
    }
    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    rotatedRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sessionId).toBe("session-after-rotation");
  });
  it("reports still shutting down when a new owner appears after waiting", async () => {
    vi.useFakeTimers();
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const previousRun = createReplyOperation({
      sessionId: "session-before-wait",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-before-wait",
      }),
    );

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    previousRun.complete();
    const nextRun = createReplyOperation({
      sessionId: "session-after-wait",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    nextRun.setPhase("running");

    const assertion = expect(runPromise).resolves.toEqual({
      text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    nextRun.complete();
  });
  it("re-drains system events after waiting behind an active run", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(drainFormattedSystemEvents)
      .mockResolvedValueOnce("System: [t] Initial event.")
      .mockResolvedValueOnce("System: [t] Post-compaction context.");

    const previousRun = createReplyOperation({
      sessionId: "session-events-after-wait",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-events-after-wait",
      }),
    );

    await Promise.resolve();
    previousRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toContain("System: [t] Initial event.");
    expect(call?.commandBody).not.toContain("System: [t] Post-compaction context.");
    expect(call?.transcriptCommandBody).not.toContain("System: [t] Initial event.");
    expect(call?.followupRun.prompt).toContain("System: [t] Initial event.");
    expect(call?.followupRun.prompt).not.toContain("System: [t] Post-compaction context.");
    expect(call?.followupRun.transcriptPrompt).not.toContain("System: [t] Initial event.");
  });

  it("threads inbound context as current-turn context without changing transcript text", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      ["Current message:", '[Replying to: "quoted status body"]', "#34974 obviyus:"].join("\n"),
    );
    vi.mocked(resolveInboundUserContextPromptJoiner).mockReturnValueOnce(" ");

    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "what does this mean?",
          RawBody: "what does this mean?",
          CommandBody: "what does this mean?",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "what does this mean?",
          BodyStripped: "what does this mean?",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          ReplyToSender: "Jake",
          ReplyToBody: "quoted status body",
          ReplyToIsQuote: true,
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toContain("what does this mean?");
    expect(call?.commandBody).not.toContain("Reply target of current user message");
    expect(call?.transcriptCommandBody).toBe("what does this mean?");
    expect(call?.followupRun.prompt).toContain("what does this mean?");
    expect(call?.followupRun.transcriptPrompt).toBe("what does this mean?");
    expect(call?.followupRun.currentInboundContext?.promptJoiner).toBe(" ");
    expect(call?.followupRun.currentInboundContext?.text).toContain("Current message:");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      '[Replying to: "quoted status body"]',
    );
    expect(call?.followupRun.currentInboundContext?.text).not.toContain(
      "Reply target of current user message",
    );
  });

  it("runs bare mention replies when the reply target is the current-turn context", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Reply target of current user message (untrusted, for context):",
        "```json",
        JSON.stringify({ sender_label: "Bot", body: "quoted status body" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "@bot",
          CommandBody: "@bot",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          ReplyToBody: "quoted status body",
          ReplyToSender: "Bot",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          RawBody: "@bot",
          CommandBody: "@bot",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          ReplyToBody: "quoted status body",
          ReplyToSender: "Bot",
        },
        command: {
          ...baseParams().command,
          rawBodyNormalized: "@bot",
          commandBodyNormalized: "",
        } as never,
      }),
    );

    expect(result).toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.transcriptCommandBody).toBe("");
    expect(call?.followupRun.prompt).toBe("");
    expect(call?.followupRun.transcriptPrompt).toBe("");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "Reply target of current user message",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("quoted status body");
  });

  it("runs room events as contextual events instead of direct user prompts", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
        "```",
        "",
        "Conversation context (untrusted, chronological, selected for current message):",
        "#35673 obviyus: @HamVerBot make a note",
        "#35674 Keśava: I wish I could enjoy 5.5",
        "#35675 obviyus ->#35674: Are you fr fr",
      ].join("\n"),
    );

    await runPreparedReply(
      baseParams({
        opts: { sourceReplyDeliveryMode: "message_tool_only" },
        ctx: {
          Body: "No wtf",
          RawBody: "No wtf",
          CommandBody: "No wtf",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "No wtf",
          BodyStripped: "No wtf",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          InboundEventKind: "room_event",
          MessageSid: "35676",
          SenderName: "Keśava",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toBe("[OpenClaw room event]");
    expect(call?.transcriptCommandBody).toBe("");
    expect(call?.followupRun.prompt).toBe("[OpenClaw room event]");
    expect(call?.followupRun.transcriptPrompt).toBe("");
    expect(call?.followupRun.currentInboundEventKind).toBe("room_event");
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call?.followupRun.run.suppressNextUserMessagePersistence).toBe(true);
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "#35675 obviyus ->#35674: Are you fr fr",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("[OpenClaw room event]");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "visible_reply_contract: message_tool_only",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "Current event:\n#35676 Keśava: No wtf",
    );
  });

  it("queues active room events as followups instead of steering fake prompts", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const abortController = new AbortController();
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.abortEmbeddedAgentRun).mockClear();
    vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockClear();
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPreparedReply(
      baseParams({
        opts: { abortSignal: abortController.signal },
        ctx: {
          Body: "ambient",
          RawBody: "ambient",
          CommandBody: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "ambient",
          BodyStripped: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          InboundEventKind: "room_event",
          MessageSid: "992",
          SenderName: "Alice",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldSteer).toBe(false);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.resolvedQueue.mode).toBe("steer");
    expect(call.followupRun.prompt).toBe("[OpenClaw room event]");
    expect(call.followupRun.currentInboundEventKind).toBe("room_event");
    expect(call.followupRun.abortSignal).toBe(abortController.signal);
    expect(call.followupRun.currentInboundContext?.text).toContain("Current event:");
  });

  it("uses queued followup abort ownership instead of borrowed active-lane abort ownership", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const activeLaneAbortController = new AbortController();
    const sourceAbortController = new AbortController();
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPreparedReply(
      baseParams({
        opts: {
          abortSignal: activeLaneAbortController.signal,
          queuedFollowupAbortSignal: sourceAbortController.signal,
        } as NonNullable<Parameters<typeof runPreparedReply>[0]["opts"]> & {
          queuedFollowupAbortSignal?: AbortSignal;
        },
        ctx: {
          Body: "ambient",
          RawBody: "ambient",
          CommandBody: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "ambient",
          BodyStripped: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          InboundEventKind: "room_event",
          MessageSid: "993",
          SenderName: "Alice",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.followupRun.currentInboundEventKind).toBe("room_event");
    expect(call.followupRun.abortSignal).toBe(sourceAbortController.signal);
  });

  it("detaches queued user requests from superseded source abort signals", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const abortController = new AbortController();
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "collect",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("user request context");

    await runPreparedReply(
      baseParams({
        opts: { abortSignal: abortController.signal },
        ctx: {
          Body: "@bot keep this",
          RawBody: "@bot keep this",
          CommandBody: "@bot keep this",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "@bot keep this",
          BodyStripped: "@bot keep this",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          InboundEventKind: "user_request",
          MessageSid: "994",
          SenderName: "Alice",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.followupRun.currentInboundEventKind).toBe("user_request");
    expect(call.followupRun.abortSignal).toBeUndefined();
  });

  it("queues active room events instead of interrupting active user requests", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "interrupt",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "ambient",
          RawBody: "ambient",
          CommandBody: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "ambient",
          BodyStripped: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          InboundEventKind: "room_event",
          MessageSid: "993",
          SenderName: "Alice",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldSteer).toBe(false);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.resolvedQueue.mode).toBe("interrupt");
    expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
  });

  it("keeps room events tool-only when group replies are automatic", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPreparedReply(
      baseParams({
        opts: { sourceReplyDeliveryMode: "automatic" },
        ctx: {
          Body: "ambient",
          RawBody: "ambient",
          CommandBody: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "ambient",
          BodyStripped: "ambient",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          InboundEventKind: "room_event",
          MessageSid: "991",
          SenderName: "Alice",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "visible_reply_contract: message_tool_only",
    );
  });

  it("keeps webchat room events on automatic source delivery", async () => {
    await runPreparedReply(
      baseParams({
        opts: { sourceReplyDeliveryMode: "automatic" },
        ctx: {
          Body: "webchat prompt",
          RawBody: "webchat prompt",
          CommandBody: "webchat prompt",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "webchat prompt",
          BodyStripped: "webchat prompt",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          InboundEventKind: "room_event",
          MessageSid: "webchat-room-event",
          SenderName: "Operator",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("automatic");
    expect(call?.followupRun.currentInboundContext?.text).not.toContain(
      "visible_reply_contract: message_tool_only",
    );
  });

  it("keeps routed external room events tool-only when provider is webchat", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPreparedReply(
      baseParams({
        opts: { sourceReplyDeliveryMode: "automatic" },
        ctx: {
          Body: "ambient",
          RawBody: "ambient",
          CommandBody: "ambient",
          Provider: "webchat",
          Surface: "telegram",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "ambient",
          BodyStripped: "ambient",
          Provider: "webchat",
          Surface: "telegram",
          ChatType: "group",
          InboundEventKind: "room_event",
          MessageSid: "routed-room-event",
          SenderName: "Alice",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "visible_reply_contract: message_tool_only",
    );
  });

  it("keeps webchat direct replies automatic when message-tool mode is requested", async () => {
    await runPreparedReply(
      baseParams({
        opts: { sourceReplyDeliveryMode: "message_tool_only" },
        ctx: {
          Body: "webchat prompt",
          RawBody: "webchat prompt",
          CommandBody: "webchat prompt",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "webchat prompt",
          BodyStripped: "webchat prompt",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          MessageSid: "webchat-direct",
          SenderName: "Operator",
        },
      }),
    );

    const directContextParams = requireMockCallArg(
      vi.mocked(buildDirectChatContext),
      "direct chat context",
    ) as { sourceReplyDeliveryMode?: string };
    const inboundPrefixCall = vi.mocked(buildInboundUserContextPrefix).mock.calls.at(-1);
    const call = requireLastRunReplyAgentCall();
    expect(directContextParams?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(inboundPrefixCall?.[2]).toEqual({ sourceReplyDeliveryMode: "message_tool_only" });
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("keeps heartbeat prompts out of visible transcript prompt", async () => {
    const heartbeatPrompt = "Read HEARTBEAT.md and run any due maintenance.";

    await runPreparedReply(
      baseParams({
        opts: { isHeartbeat: true },
        ctx: {
          Body: heartbeatPrompt,
          RawBody: heartbeatPrompt,
          CommandBody: heartbeatPrompt,
          Provider: "heartbeat",
          Surface: "heartbeat",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: heartbeatPrompt,
          BodyStripped: heartbeatPrompt,
          Provider: "heartbeat",
          Surface: "heartbeat",
          ChatType: "direct",
        },
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toContain(heartbeatPrompt);
    expect(call?.followupRun.prompt).toContain(heartbeatPrompt);
    expect(call?.transcriptCommandBody).toBe("[OpenClaw heartbeat poll]");
    expect(call?.followupRun.transcriptPrompt).toBe("[OpenClaw heartbeat poll]");
  });

  it("uses persisted Discord chat metadata for system-event CLI static prompt identity", async () => {
    vi.mocked(buildGroupChatContext).mockImplementationOnce(({ sessionCtx }) =>
      [`group`, sessionCtx.Provider, sessionCtx.ChatType, sessionCtx.GroupChannel].join(":"),
    );

    await runPreparedReply(
      baseParams({
        opts: { isHeartbeat: true },
        isNewSession: false,
        systemSent: true,
        ctx: {
          Body: "scheduled wake",
          RawBody: "scheduled wake",
          CommandBody: "scheduled wake",
          Provider: "cron-event",
          SessionKey: "agent:main:discord:guild-1:channel-1",
        },
        sessionCtx: {
          Body: "scheduled wake",
          BodyStripped: "scheduled wake",
          Provider: "cron-event",
        },
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          systemSent: true,
          chatType: "channel",
          channel: "discord",
          groupId: "guild-1",
          groupChannel: "#ops",
          lastChannel: "discord",
          lastTo: "channel-1",
          origin: {
            provider: "discord",
            surface: "discord",
            chatType: "channel",
            to: "channel-1",
          },
        } as SessionEntry,
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(buildGroupChatContext).toHaveBeenCalledTimes(1);
    const groupContextParams = requireMockCallArg(
      vi.mocked(buildGroupChatContext),
      "group chat context",
    ) as {
      sessionCtx?: {
        Provider?: string;
        Surface?: string;
        ChatType?: string;
        GroupChannel?: string;
      };
    };
    expect(groupContextParams?.sessionCtx?.Provider).toBe("discord");
    expect(groupContextParams?.sessionCtx?.Surface).toBe("discord");
    expect(groupContextParams?.sessionCtx?.ChatType).toBe("channel");
    expect(groupContextParams?.sessionCtx?.GroupChannel).toBe("#ops");
    expect(call?.followupRun.run.extraSystemPromptStatic).toBe("group:discord:channel:#ops");
  });

  it.each([
    ["/new", "new"],
    ["/reset", "reset"],
  ] as const)(
    "keeps inbound sender context in reply-targeted bare %s model prompt while hiding startup instructions from transcript prompt",
    async (commandText, startupAction) => {
      vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
        [
          "Conversation info (untrusted metadata):",
          "Sender (untrusted metadata):",
          "sender_id",
          "telegram-user-1",
        ].join("\n"),
      );

      await runPreparedReply(
        baseParams({
          ctx: {
            Body: commandText,
            RawBody: commandText,
            CommandBody: commandText,
            Provider: "webchat",
            Surface: "webchat",
            ChatType: "direct",
            ReplyToBody: "quoted reset target",
            ReplyToSender: "Ada Lovelace",
          },
          sessionCtx: {
            Body: "",
            BodyStripped: "",
            Provider: "webchat",
            Surface: "webchat",
            ChatType: "direct",
            SenderId: "telegram-user-1",
            SenderName: "Ada Lovelace",
            ReplyToBody: "quoted reset target",
            ReplyToSender: "Ada Lovelace",
          },
          command: {
            surface: "webchat",
            channel: "webchat",
            isAuthorizedSender: true,
            abortKey: "session-key",
            ownerList: [],
            senderIsOwner: true,
            rawBodyNormalized: commandText,
            commandBodyNormalized: commandText,
          } as never,
        }),
      );

      const call = requireLastRunReplyAgentCall();
      expect(call?.commandBody).toContain("A new session was started via /new or /reset.");
      expect(call?.commandBody).toContain("Conversation info (untrusted metadata):");
      expect(call?.commandBody).toContain("Sender (untrusted metadata):");
      expect(call?.commandBody).toContain("telegram-user-1");
      expect(call?.followupRun.prompt).toContain("A new session was started via /new or /reset.");
      expect(call?.followupRun.prompt).toContain("Sender (untrusted metadata):");
      expect(call?.transcriptCommandBody).toBe(`[OpenClaw session ${startupAction}]`);
      expect(call?.followupRun.transcriptPrompt).toBe(`[OpenClaw session ${startupAction}]`);
      expect(call?.followupRun.transcriptPrompt).not.toContain("Sender (untrusted metadata):");
    },
  );

  it("keeps reset user notes visible while hiding startup instructions", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "/reset summarize my workspace",
          RawBody: "/reset summarize my workspace",
          CommandBody: "/reset summarize my workspace",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
        },
        command: {
          surface: "webchat",
          channel: "webchat",
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: true,
          rawBodyNormalized: "/reset summarize my workspace",
          commandBodyNormalized: "/reset summarize my workspace",
          softResetTriggered: true,
          softResetTail: "summarize my workspace",
        } as never,
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toContain("A new session was started via /new or /reset.");
    expect(call?.commandBody).toContain("summarize my workspace");
    expect(call?.transcriptCommandBody).toBe("summarize my workspace");
    expect(call?.followupRun.transcriptPrompt).toBe("summarize my workspace");
  });

  it("uses inbound origin channel for run messageProvider", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:abc",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "telegram",
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
        },
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.messageProvider).toBe("webchat");
  });

  it("prefers Provider over Surface when origin channel is missing", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
          Provider: "feishu",
          Surface: "webchat",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "webchat",
          ChatType: "group",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
        },
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.messageProvider).toBe("feishu");
  });

  it("uses the effective session account for followup originatingAccountId when AccountId is omitted", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:24680",
          ChatType: "group",
          AccountId: undefined,
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "discord",
          ChatType: "group",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:24680",
          ReplyToId: "reply-24680",
          AccountId: "work",
        },
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.originatingAccountId).toBe("work");
    expect(call?.followupRun.originatingReplyToId).toBe("reply-24680");
  });

  it("uses transport thread metadata for followup originatingThreadId", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U1",
          ChatType: "direct",
          MessageThreadId: undefined,
          TransportThreadId: "650.000",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "slack",
          ChatType: "direct",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U1",
          TransportThreadId: "650.000",
        },
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.originatingThreadId).toBe("650.000");
  });

  it("passes suppressTyping through typing mode resolution", async () => {
    await runPreparedReply(
      baseParams({
        opts: {
          suppressTyping: true,
        },
      }),
    );

    const call = requireMockCallArg(vi.mocked(resolveTypingMode), "typing mode params") as {
      suppressTyping?: boolean;
    };
    expect(call?.suppressTyping).toBe(true);
  });

  it("routes queued system events into user prompt text, not system prompt context", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Model switched.");

    await runPreparedReply(baseParams());

    const call = requireRunReplyAgentCall();
    expect(call.commandBody).toContain("System: [t] Model switched.");
    expect(call.followupRun.run.extraSystemPrompt ?? "").not.toContain("Runtime System Events");
  });

  it("keeps sender ownership when queued system events are prepended", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(
      "System: [t] External webhook payload.",
    );
    const params = ownerParams();

    await runPreparedReply(params);

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.senderIsOwner).toBe(true);
  });

  it("keeps sender ownership when drained system events are present", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Trusted event.");
    const params = ownerParams();

    await runPreparedReply(params);

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.senderIsOwner).toBe(true);
  });

  it("does not downgrade sender ownership when event text contains the untrusted marker", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(
      "System: [t] Relay text mentions System (untrusted): but event is trusted.",
    );
    const params = ownerParams();

    await runPreparedReply(params);

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.senderIsOwner).toBe(true);
  });

  it("preserves first-token think hint when system events are prepended", async () => {
    // drainFormattedSystemEvents returns the events block; the caller prepends it.
    // The hint must be extracted from the user body BEFORE prepending, so "System:"
    // does not shadow the low|medium|high shorthand.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPreparedReply(
      baseParams({
        ctx: { Body: "low tell me about cats", RawBody: "low tell me about cats" },
        sessionCtx: { Body: "low tell me about cats", BodyStripped: "low tell me about cats" },
        resolvedThinkLevel: undefined,
      }),
    );

    const call = requireRunReplyAgentCall();
    // Think hint extracted before events arrived — level must be "low", not the model default.
    expect(call.followupRun.run.thinkLevel).toBe("low");
    // The stripped user text (no "low" token) must still appear after the event block.
    expect(call.commandBody).toContain("tell me about cats");
    expect(call.commandBody).not.toMatch(/^low\b/);
    // System events are still present in the body.
    expect(call.commandBody).toContain("System: [t] Node connected.");
  });

  it("carries system events into followupRun.prompt for deferred turns", async () => {
    // drainFormattedSystemEvents returns the events block; the caller prepends it to
    // effectiveBaseBody for the queue path so deferred turns see events.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPreparedReply(baseParams());

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("System: [t] Node connected.");
  });

  it("does not strip think-hint token from deferred queue body", async () => {
    // In steer mode the inferred thinkLevel is never consumed, so the first token
    // must not be stripped from the queue/steer body (followupRun.prompt).
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(undefined);

    await runPreparedReply(
      baseParams({
        ctx: { Body: "low steer this conversation", RawBody: "low steer this conversation" },
        sessionCtx: {
          Body: "low steer this conversation",
          BodyStripped: "low steer this conversation",
        },
        resolvedThinkLevel: undefined,
      }),
    );

    const call = requireRunReplyAgentCall();
    // Queue body (used by steer mode) must keep the full original text.
    expect(call.followupRun.prompt).toContain("low steer this conversation");
  });
});
