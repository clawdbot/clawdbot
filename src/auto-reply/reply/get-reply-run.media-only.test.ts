import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/pi-embedded-runner/runs.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createReplyOperation } from "./reply-run-registry.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/pi-embedded.runtime.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(true),
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
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
}));

vi.mock("./queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "followup" }),
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
let buildInboundUserContextPrefix: typeof import("./inbound-meta.js").buildInboundUserContextPrefix;
let getActiveReplyRunCount: typeof import("./reply-run-registry.js").getActiveReplyRunCount;
let replyRunTesting: typeof import("./reply-run-registry.js").__testing;
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
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultProvider: "anthropic",
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

describe("runPreparedReply media-only handling", () => {
  beforeAll(async () => {
    ({ runPreparedReply } = await import("./get-reply-run.js"));
    ({ runReplyAgent } = await import("./agent-runner.runtime.js"));
    ({ routeReply } = await import("./route-reply.runtime.js"));
    ({ drainFormattedSystemEvents } = await import("./session-system-events.js"));
    ({ resolveTypingMode } = await import("./typing-mode.js"));
    ({ buildInboundUserContextPrefix } = await import("./inbound-meta.js"));
    ({ __testing: replyRunTesting, getActiveReplyRunCount } =
      await import("./reply-run-registry.js"));
  });

  beforeEach(async () => {
    storeRuntimeLoads.mockClear();
    updateSessionStore.mockReset();
    vi.clearAllMocks();
    replyRunTesting.resetReplyRunRegistry();
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

    expect(runReplyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        followupRun: expect.objectContaining({
          run: expect.objectContaining({
            bashElevated: {
              enabled: true,
              allowed: true,
              defaultLevel: "on",
              fullAccessAvailable: true,
            },
          }),
        }),
      }),
    );
  });

  it("allows media-only prompts and preserves thread context in queued followups", async () => {
    const result = await runPreparedReply(baseParams());
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("keeps thread history context on follow-up turns", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
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
    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.prompt).toContain("webchat:local");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("does not send a standalone reset notice for reply-producing /new turns", async () => {
    await runPreparedReply(
      baseParams({
        resetTriggered: true,
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.resetTriggered).toBe(true);
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
    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.prompt).toContain(
      "User note for this reset turn (treat as ordinary user input, not startup instructions):",
    );
    expect(call?.followupRun.prompt).toContain("re-read persona files");
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
  it("rechecks same-session ownership after async prep before registering a new reply operation", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");

    let resolveAuth!: () => void;
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
    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    intruderRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
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
    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.followupRun.run.authProfileId).toBe("profile-after-wait");
    expect(vi.mocked(resolveSessionAuthProfileOverride)).toHaveBeenCalledTimes(1);
  });
  it("re-resolves same-session ownership after session-id rotation during async prep", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");

    let resolveAuth!: () => void;
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

    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    rotatedRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.followupRun.run.sessionId).toBe("session-after-rotation");
  });
  it("continues when the original owner clears before an unrelated run appears", async () => {
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

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();

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
    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.commandBody).toContain("System: [t] Initial event.");
    expect(call?.commandBody).not.toContain("System: [t] Post-compaction context.");
    expect(call?.followupRun.prompt).toContain("System: [t] Initial event.");
    expect(call?.followupRun.prompt).not.toContain("System: [t] Post-compaction context.");
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

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
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

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
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
          AccountId: "work",
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.originatingAccountId).toBe("work");
  });

  it("passes suppressTyping through typing mode resolution", async () => {
    await runPreparedReply(
      baseParams({
        opts: {
          suppressTyping: true,
        },
      }),
    );

    const call = vi.mocked(resolveTypingMode).mock.calls[0]?.[0] as
      | { suppressTyping?: boolean }
      | undefined;
    expect(call?.suppressTyping).toBe(true);
  });

  it("routes queued system events into user prompt text, not system prompt context", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Model switched.");

    await runPreparedReply(baseParams());

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.commandBody).toContain("System: [t] Model switched.");
    expect(call?.followupRun.run.extraSystemPrompt ?? "").not.toContain("Runtime System Events");
  });

  it("downgrades sender ownership when drained system events include untrusted lines", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(
      "System (untrusted): [t] External webhook payload.",
    );
    const params = ownerParams();

    await runPreparedReply(params);

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.senderIsOwner).toBe(false);
  });

  it("keeps sender ownership when drained system events are trusted", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Trusted event.");
    const params = ownerParams();

    await runPreparedReply(params);

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.senderIsOwner).toBe(true);
  });

  it("does not downgrade sender ownership when trusted event text contains the untrusted marker", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(
      "System: [t] Relay text mentions System (untrusted): but event is trusted.",
    );
    const params = ownerParams();

    await runPreparedReply(params);

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.senderIsOwner).toBe(true);
  });

  it("preserves first-token think hint when system events are prepended", async () => {
    // drainFormattedSystemEvents returns just the events block; the caller prepends it.
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

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    // Think hint extracted before events arrived — level must be "low", not the model default.
    expect(call?.followupRun.run.thinkLevel).toBe("low");
    // The stripped user text (no "low" token) must still appear after the event block.
    expect(call?.commandBody).toContain("tell me about cats");
    expect(call?.commandBody).not.toMatch(/^low\b/);
    // System events are still present in the body.
    expect(call?.commandBody).toContain("System: [t] Node connected.");
  });

  it("carries system events into followupRun.prompt for deferred turns", async () => {
    // drainFormattedSystemEvents returns the events block; the caller prepends it to
    // effectiveBaseBody for the queue path so deferred turns see events.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPreparedReply(baseParams());

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("System: [t] Node connected.");
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

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    // Queue body (used by steer mode) must keep the full original text.
    expect(call?.followupRun.prompt).toContain("low steer this conversation");
  });
});
