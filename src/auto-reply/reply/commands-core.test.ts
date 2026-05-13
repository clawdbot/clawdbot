import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      readFile: fsMocks.readFile,
      readdir: fsMocks.readdir,
    },
    readFile: fsMocks.readFile,
    readdir: fsMocks.readdir,
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
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1);
    const [, ctx] = firstBeforeResetCall();
    return ctx;
  }

  beforeEach(() => {
    fsMocks.readFile.mockReset();
    fsMocks.readdir.mockReset();
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    fsMocks.readFile.mockResolvedValue("");
    fsMocks.readdir.mockResolvedValue([]);
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

  it("recovers the archived transcript when the original reset transcript path is gone", async () => {
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMocks.readdir.mockResolvedValueOnce(["prev-session.jsonl.reset.2026-02-16T22-26-33.000Z"]);
    fsMocks.readFile.mockResolvedValueOnce(
      `${JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "user", content: "Recovered from archive" },
      })}\n`,
    );
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
      previousSessionEntry: {
        sessionId: "prev-session",
        sessionFile: "/tmp/prev-session.jsonl",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    const [event, ctx] = firstBeforeResetCall();
    expect(event.sessionFile).toBe("/tmp/prev-session.jsonl.reset.2026-02-16T22-26-33.000Z");
    expect(event.messages).toEqual([{ role: "user", content: "Recovered from archive" }]);
    expect(event.reason).toBe("new");
    expect(ctx.sessionId).toBe("prev-session");
  });
});
