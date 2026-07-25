// Tests core command dispatch, reset hooks, authorization, and send policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

// Tests core command dispatch, aliases, authorization, and handler outcomes.

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
  loadTranscriptEvents: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("../../config/sessions/session-accessor.js", () => {
  return {
    loadTranscriptEvents: hookRunnerMocks.loadTranscriptEvents,
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

const { emitResetCommandHooks } = await import("./commands-reset-hooks.js");

function firstBeforeResetCall() {
  const call = hookRunnerMocks.runBeforeReset.mock.calls[0] as
    | [Record<string, unknown>, Record<string, unknown>]
    | undefined;
  if (!call) {
    throw new Error("expected before reset hook call");
  }
  return call;
}

describe("emitResetCommandHooks", () => {
  async function runBeforeResetContext(sessionKey?: string) {
    const command = {
      surface: "discord",
      senderId: "rai",
      channel: "discord",
      from: "discord:rai",
      to: "discord:bot",
      resetHookTriggered: false,
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "new",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      sessionKey,
      previousSessionEntry: {
        sessionId: "prev-session",
      } as HandleCommandsParams["previousSessionEntry"],
      storePath: "/tmp/openclaw-agent.sqlite",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1);
    const [, ctx] = firstBeforeResetCall();
    return ctx;
  }

  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.loadTranscriptEvents.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    hookRunnerMocks.loadTranscriptEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the bound agent id to before_reset hooks for multi-agent session keys", async () => {
    const ctx = await runBeforeResetContext("agent:navi:main");
    expect(ctx?.agentId).toBe("navi");
    expect(ctx?.sessionKey).toBe("agent:navi:main");
    expect(ctx?.sessionId).toBe("prev-session");
    expect(ctx?.workspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("falls back to main when the reset hook has no session key", async () => {
    const ctx = await runBeforeResetContext(undefined);
    expect(ctx?.agentId).toBe("main");
    expect(ctx?.sessionKey).toBeUndefined();
    expect(ctx?.sessionId).toBe("prev-session");
    expect(ctx?.workspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("keeps the main-agent path on the main agent workspace", async () => {
    const ctx = await runBeforeResetContext("agent:main:main");
    expect(ctx?.agentId).toBe("main");
    expect(ctx?.sessionKey).toBe("agent:main:main");
    expect(ctx?.sessionId).toBe("prev-session");
    expect(ctx?.workspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("loads marker-backed before_reset transcripts by session identity", async () => {
    hookRunnerMocks.loadTranscriptEvents.mockResolvedValueOnce([
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: "Recovered from archive" },
      },
    ]);
    const command = {
      surface: "telegram",
      senderId: "vac",
      channel: "telegram",
      from: "telegram:vac",
      to: "telegram:bot",
      resetHookTriggered: false,
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "new",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      sessionKey: "agent:main:telegram:group:-1003826723328:topic:8428",
      storePath: "/tmp/openclaw-agent.sqlite",
      previousSessionEntry: {
        sessionId: "prev-session",
        sessionFile: "sqlite:main:prev-session:/tmp/openclaw-agent.sqlite",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    const [event, ctx] = firstBeforeResetCall();
    expect(hookRunnerMocks.loadTranscriptEvents).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "prev-session",
      sessionKey: "agent:main:telegram:group:-1003826723328:topic:8428",
      storePath: "/tmp/openclaw-agent.sqlite",
    });
    expect(event.sessionFile).toBe("sqlite:main:prev-session:/tmp/openclaw-agent.sqlite");
    expect(event.messages).toEqual([{ role: "user", content: "Recovered from archive" }]);
    expect(event.reason).toBe("new");
    expect(ctx.sessionId).toBe("prev-session");
  });

  it("keeps leaf-controlled side branches out of before_reset hooks", async () => {
    hookRunnerMocks.loadTranscriptEvents.mockResolvedValueOnce([
      {
        type: "message",
        id: "active-root",
        parentId: null,
        message: { role: "user", content: "active root" },
      },
      {
        type: "message",
        id: "side-entry",
        parentId: "active-root",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-entry",
        targetId: "active-root",
      },
      {
        type: "message",
        id: "active-tail",
        parentId: "active-root",
        message: { role: "assistant", content: "active tail" },
      },
      {
        type: "metadata",
        id: "opaque-after-active-tail",
        parentId: "side-entry",
      },
    ]);

    await emitResetCommandHooks({
      action: "new",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command: {
        surface: "discord",
        senderId: "rai",
        channel: "discord",
        from: "discord:rai",
        to: "discord:bot",
        resetHookTriggered: false,
      } as HandleCommandsParams["command"],
      sessionKey: "agent:main:main",
      storePath: "/tmp/openclaw-agent.sqlite",
      previousSessionEntry: {
        sessionId: "prev-session",
        sessionFile: "sqlite:main:prev-session:/tmp/openclaw-agent.sqlite",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    const [event] = firstBeforeResetCall();
    expect(event.messages).toEqual([
      { role: "user", content: "active root" },
      { role: "assistant", content: "active tail" },
    ]);
  });
});

// Tests command send policy behavior for visible replies and message-tool routing.

const loadCommandHandlersMock = vi.hoisted(
  (): ReturnType<typeof vi.fn<() => CommandHandler[]>> => vi.fn<() => CommandHandler[]>(() => []),
);

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => loadCommandHandlersMock(),
}));

vi.mock("./commands-reset.js", () => ({
  maybeHandleResetCommand: vi.fn(async () => null),
}));

vi.mock("../commands-registry.js", () => ({
  shouldHandleTextCommands: vi.fn(() => true),
}));

function makeParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { channel: "telegram" } }],
        },
      },
    },
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: "/unknown",
      rawBodyNormalized: "/unknown",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "owner",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:target:main",
    sessionEntry: {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      channel: "whatsapp",
      chatType: "direct",
    },
    sessionStore: {
      "agent:target:main": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        channel: "telegram",
        chatType: "direct",
      },
    },
    workspaceDir: "/tmp/workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("handleCommands send policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    loadCommandHandlersMock.mockReturnValue([]);
  });

  it("allows processing to continue even when send policy is deny (#53328)", async () => {
    const { handleCommands } = await import("./commands-core.js");
    // sendPolicy deny now only suppresses outbound delivery, not inbound processing.
    // The deny gate moved to dispatch-from-config.ts where it suppresses delivery
    // after the agent has processed the message.
    const result = await handleCommands(makeParams());

    expect(result).toEqual({ shouldContinue: true });
  });

  it("marks command replies as non-threaded", async () => {
    const { handleCommands } = await import("./commands-core.js");
    loadCommandHandlersMock.mockReturnValue([
      vi.fn(async () => ({
        shouldContinue: false,
        reply: {
          text: "done",
          replyToId: "msg-123",
          replyToCurrent: true,
        },
      })),
    ]);

    const result = await handleCommands(makeParams());

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "done",
        replyToId: undefined,
        replyToCurrent: false,
      },
    });
  });
});
