// Tests core command dispatch, aliases, authorization, and handler outcomes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

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
