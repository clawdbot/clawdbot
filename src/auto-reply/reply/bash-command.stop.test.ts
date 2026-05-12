import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

const { getSessionMock, getFinishedSessionMock, killProcessTreeMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getFinishedSessionMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getSession: getSessionMock,
  getFinishedSession: getFinishedSessionMock,
  markExited: vi.fn(),
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

const { handleBashChatCommand } = await import("./bash-command.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { bash: true },
  } as OpenClawConfig;

  const ctx = {
    CommandBody: commandBody,
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

describe("handleBashChatCommand stop", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getFinishedSessionMock.mockReset();
    killProcessTreeMock.mockReset();
  });

  it("returns immediately with a stopping message and fires killProcessTree", async () => {
    const session = buildRunningSession();
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("bash stopping");
    expect(result.text).toContain("!poll session-1");
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
  });

  it("includes the full session ID so the user can poll after starting a new job", async () => {
    const session = buildRunningSession({ id: "deep-forest-42" });
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop deep-forest-42"));

    expect(result.text).toContain("!poll deep-forest-42");
  });

  it("does not call markExited synchronously (defers to supervisor lifecycle)", async () => {
    const session = buildRunningSession();
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(session.exited).toBe(false);
  });

  it("returns no-running-job when session is not found", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("No running bash job found");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  it("fails stop when session has no pid", async () => {
    const session = buildRunningSession({ pid: undefined, child: undefined });
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("Unable to stop bash session");
    expect(result.text).toContain("!poll session-1");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
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
