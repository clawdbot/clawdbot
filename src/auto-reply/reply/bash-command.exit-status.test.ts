import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

const { createExecToolMock, getFinishedSessionMock, getSessionMock } = vi.hoisted(() => ({
  createExecToolMock: vi.fn(),
  getFinishedSessionMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock("../../agents/bash-process-control.js", () => ({
  cancelBackgroundExecSession: vi.fn(),
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getFinishedSession: getFinishedSessionMock,
  getSession: getSessionMock,
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: createExecToolMock,
}));

const { handleBashChatCommand } = await import("./bash-command.js");

function buildParams(commandText: string) {
  return {
    ctx: {
      CommandBody: commandText,
      commandText,
    } as MsgContext,
    cfg: {
      commands: { bash: true, bashForegroundMs: 30_000 },
    } as OpenClawConfig,
    sessionKey: "agent:main:test:bash-exit",
    isGroup: false,
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
  };
}

describe("bash chat command exit status", () => {
  beforeEach(() => {
    createExecToolMock.mockReset();
    getFinishedSessionMock.mockReset();
    getSessionMock.mockReset();
  });

  it("preserves the exit code from a failed foreground command", async () => {
    createExecToolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Command not found" }],
        details: {
          status: "failed",
          exitCode: 127,
          durationMs: 1,
          aggregated: "",
        },
      }),
    });

    const result = await handleBashChatCommand(buildParams("/bash missing-command"));

    expect(result.text).toContain("Exit: code 127");
    expect(result.text).toContain("Command not found");
  });

  it.each([
    {
      name: "signal",
      exitCode: null,
      exitSignal: "SIGTERM",
      expected: "Exit: signal SIGTERM",
    },
    {
      name: "unknown",
      exitCode: null,
      exitSignal: null,
      expected: "Exit: unknown exit code",
    },
  ])("preserves a finished session's $name exit", async (testCase) => {
    createExecToolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        content: [],
        details: {
          status: "running",
          sessionId: `session-${testCase.name}`,
          startedAt: Date.now(),
        },
      }),
    });
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);
    await handleBashChatCommand(buildParams(`/bash start-${testCase.name}`));

    getFinishedSessionMock.mockReturnValue({
      id: `session-${testCase.name}`,
      scopeKey: "chat:bash",
      terminalStatus: "failed",
      exitCode: testCase.exitCode,
      exitSignal: testCase.exitSignal,
      aggregated: "",
      tail: "",
    });
    const result = await handleBashChatCommand(buildParams(`/bash poll session-${testCase.name}`));

    expect(result.text).toContain(testCase.expected);
  });
});
