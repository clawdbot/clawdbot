// Tests bash stop command handling and active-process cancellation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

const {
  cancelBackgroundExecSessionMock,
  createExecToolMock,
  getFinishedSessionMock,
  getSessionMock,
} = vi.hoisted(() => ({
  cancelBackgroundExecSessionMock: vi.fn(),
  createExecToolMock: vi.fn(),
  getSessionMock: vi.fn(),
  getFinishedSessionMock: vi.fn(),
}));

vi.mock("../../agents/bash-process-control.js", () => ({
  cancelBackgroundExecSession: cancelBackgroundExecSessionMock,
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getSession: getSessionMock,
  getFinishedSession: getFinishedSessionMock,
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: createExecToolMock,
}));

const { handleBashChatCommand } = await import("./bash-command.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { bash: true },
  } as OpenClawConfig;

  const ctx = {
    CommandBody: commandBody,
    commandText: commandBody,
    SessionKey: "session-key",
  } as MsgContext;

  return {
    ctx,
    cfg,
    sessionKey: "session-key",
    isGroup: false,
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
  };
}

function buildElevatedDeniedParams(commandBody: string) {
  const base = buildParams(commandBody);
  return {
    ...base,
    ctx: {
      ...base.ctx,
      SessionKey: "agent:main:telegram:slash-session",
    } as MsgContext,
    agentId: "main",
    sessionKey: "agent:target:telegram:direct:target-session",
    elevated: {
      enabled: true,
      allowed: false,
      failures: [],
    },
  };
}

function buildRunningSession(overrides?: Record<string, unknown>) {
  return {
    id: "session-1",
    scopeKey: "chat:bash",
    backgrounded: true,
    pid: 4242,
    exited: false,
    startedAt: Date.now(),
    tail: "",
    ...overrides,
  };
}

function backgroundExecResult(sessionId: string) {
  return {
    content: [],
    details: { status: "running", sessionId, startedAt: Date.now() },
  };
}

describe("handleBashChatCommand stop", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getFinishedSessionMock.mockReset();
    cancelBackgroundExecSessionMock.mockReset();
    cancelBackgroundExecSessionMock.mockReturnValue(true);
    createExecToolMock.mockReset();
  });

  it("returns immediately after canonical cancellation is admitted", async () => {
    const session = buildRunningSession();
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("bash stopping");
    expect(result.text).toContain("!poll session-1");
    expect(cancelBackgroundExecSessionMock).toHaveBeenCalledWith("session-1");
    expect(session.exited).toBe(false);
  });

  it("includes the full session ID so the user can poll after starting a new job", async () => {
    const session = buildRunningSession({ id: "deep-forest-42" });
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop deep-forest-42"));

    expect(result.text).toContain("!poll deep-forest-42");
  });

  it("returns no-running-job when session is not found", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("No running bash job found");
    expect(cancelBackgroundExecSessionMock).not.toHaveBeenCalled();
  });

  it("does not split boundary emoji in missing session snippets", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop 1234567😀tail"));

    expect(result.text).toBe("⚙️ No running bash job found for 1234567….");
  });

  it("returns actionable guidance when canonical cancellation is not admitted", async () => {
    const session = buildRunningSession();
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);
    cancelBackgroundExecSessionMock.mockReturnValue(false);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("Unable to stop bash session");
    expect(result.text).toContain("!poll session-1");
    expect(result.text).toContain("no active cancellation handle");
    expect(cancelBackgroundExecSessionMock).toHaveBeenCalledWith("session-1");
  });

  it("clears active job state from registry lifecycle without a child watcher", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(backgroundExecResult("session-first"))
      .mockResolvedValueOnce(backgroundExecResult("session-second"));
    createExecToolMock.mockReturnValue({ execute });
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    await handleBashChatCommand(buildParams("/bash first"));
    const firstSession = buildRunningSession({ id: "session-first" });
    getSessionMock.mockReturnValue(firstSession);
    await handleBashChatCommand(buildParams("/bash stop"));
    expect(cancelBackgroundExecSessionMock).toHaveBeenCalledWith("session-first");

    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue({
      id: "session-first",
      scopeKey: "chat:bash",
      status: "failed",
    });
    const restarted = await handleBashChatCommand(buildParams("/bash second"));
    expect(restarted.text).toContain("session-second");
    expect(execute).toHaveBeenCalledTimes(2);

    getFinishedSessionMock.mockReturnValue(undefined);
    await handleBashChatCommand(buildParams("/bash help"));
  });

  it("uses the canonical target session for elevated sandbox explanation", async () => {
    const sandboxRuntime = await import("../../agents/sandbox.js");
    const resolveSandboxRuntimeStatusSpy = vi
      .spyOn(sandboxRuntime, "resolveSandboxRuntimeStatus")
      .mockReturnValue({
        agentId: "target",
        sessionKey: "agent:target:telegram:direct:target-session",
        mainSessionKey: "agent:target:main",
        mode: "non-main",
        sandboxed: true,
        toolPolicy: {
          allow: [],
          deny: ["bash"],
          sources: {
            allow: { source: "default", key: "agents.defaults.tools.sandbox.tools.allow" },
            deny: { source: "default", key: "agents.defaults.tools.sandbox.tools.deny" },
          },
        },
      });

    const params = buildElevatedDeniedParams("/bash pwd");
    const result = await handleBashChatCommand(params);

    expect(resolveSandboxRuntimeStatusSpy).toHaveBeenCalledWith({
      cfg: params.cfg,
      sessionKey: "agent:target:telegram:direct:target-session",
    });
    expect(result.text).toContain(
      "openclaw sandbox explain --session agent:target:telegram:direct:target-session",
    );
    expect(result.text).not.toContain(
      "openclaw sandbox explain --session agent:main:telegram:slash-session",
    );
  });
});
