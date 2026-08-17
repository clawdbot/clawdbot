import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
} from "../../gateway/mcp-http.loopback-runtime.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { PLUGIN_APPROVAL_DETAIL_MAX_LENGTH } from "../../infra/plugin-approvals.js";
import {
  buildClaudeControlRequestEvents,
  buildClaudeLiveRunContext,
  createCancelableLiveRunLifecycle,
  createClaudeInputStartedEvent,
  expectClaudeControlDecision,
  mockClaudeLiveRun,
} from "../cli-runner.test-helpers.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import { callGatewayTool } from "../tools/gateway.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { executePreparedCliRun } from "./execute.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function emitClaudeInputStarted(stdout: ((chunk: string) => void) | undefined, data: string): void {
  const event = createClaudeInputStartedEvent(data);
  if (event) {
    stdout?.(`${JSON.stringify(event)}\n`);
  }
}

beforeEach(() => {
  resetClaudeLiveSessionsForTest();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
  mockCallGatewayTool.mockReset();
  mockCallGatewayTool.mockResolvedValue({ id: "claude-native-approval", decision: "deny" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetClaudeLiveSessionsForTest();
});

describe("Claude live process approvals", () => {
  it("answers Claude live control_request can_use_tool with allow when exec policy is full/no-ask", async () => {
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-allow",
        toolUseId: "tool-allow-1",
        input: { command: "ls" },
        sessionId: "live-control-allow",
      }),
      pid: 3001,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "full", ask: "off" } } },
      }),
    );
    expect(result.text).toBe("ok");
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-allow",
      toolUseId: "tool-allow-1",
      updatedInput: { command: "ls" },
    });
  });

  it.each([
    {
      name: "session deny overrides broader global and agent full policy",
      requestId: "req-session-security-deny",
      toolUseId: "tool-session-security-deny-1",
      context: () =>
        buildClaudeLiveRunContext({
          sessionKey: "agent:main:main",
          sessionEntry: {
            sessionId: "session-policy-test",
            updatedAt: 1,
            execSecurity: "deny",
          },
          config: {
            tools: { exec: { security: "full", ask: "off" } },
            agents: {
              list: [
                {
                  id: "main",
                  default: true,
                  tools: { exec: { security: "full", ask: "off" } },
                },
              ],
            },
          },
        }),
    },
    {
      name: "partial agent policy inherits restrictive global security",
      requestId: "req-partial-agent-global-deny",
      toolUseId: "tool-partial-agent-global-deny-1",
      context: () =>
        buildClaudeLiveRunContext({
          sessionKey: "agent:main:main",
          config: {
            tools: { exec: { security: "deny", ask: "off" } },
            agents: {
              list: [
                {
                  id: "main",
                  default: true,
                  tools: { exec: { ask: "off" } },
                },
              ],
            },
          },
        }),
    },
  ])("denies Claude live native tools when $name", async ({ requestId, toolUseId, context }) => {
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId,
        toolUseId,
        input: { command: "ls" },
        sessionId: requestId,
      }),
    });

    const result = await executePreparedCliRun(context());

    expect(result.text).toBe("ok");
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId,
      messageIncludes: "security=deny",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("preserves image and PDF bytes inside approved Claude live control inputs", async () => {
    const input = {
      command: "process media",
      image: {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
      document: {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
      },
    };
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-allow-media",
        toolUseId: "tool-allow-media",
        input,
        sessionId: "live-control-allow-media",
      }),
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "full", ask: "off" } } },
      }),
    );

    expect(result.text).toBe("ok");
    const response = expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-allow-media",
      toolUseId: "tool-allow-media",
      updatedInput: input,
    });
    expect(JSON.stringify(response.response.response.updatedInput)).toBe(JSON.stringify(input));
  });

  it("honors allow-once from a Claude native tool Gateway approval", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-allow-once",
      decision: "allow-once",
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-allow-once",
        toolUseId: "tool-allow-once-1",
        input: { command: "ls" },
        sessionId: "live-control-allow-once",
      }),
      pid: 3011,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-allow-once",
      toolUseId: "tool-allow-once-1",
      updatedInput: { command: "ls" },
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        pluginId: "claude-cli",
        toolName: "Bash",
        toolCallId: "tool-allow-once-1",
      }),
      { expectFinal: false },
    );
  });

  it("denies Claude Bash when an approved script operand changes before release", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-drift-"));
    const scriptPath = path.join(workspaceDir, "script.sh");
    try {
      await fs.writeFile(scriptPath, "#!/bin/sh\necho approved\n");
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "claude-native-script-drift" })
        .mockImplementationOnce(async () => {
          await fs.writeFile(scriptPath, "#!/bin/sh\necho mutated\n");
          return { id: "claude-native-script-drift", decision: "allow-once" };
        });
      const live = mockClaudeLiveRun(supervisorSpawnMock, {
        events: buildClaudeControlRequestEvents({
          requestId: "req-script-drift",
          toolUseId: "tool-script-drift",
          input: { command: "sh script.sh" },
          sessionId: "live-script-drift",
        }),
      });

      await executePreparedCliRun(
        buildClaudeLiveRunContext({
          workspaceDir,
          config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
        }),
      );

      await vi.waitFor(() =>
        expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
      );
      expectClaudeControlDecision(live, {
        behavior: "deny",
        requestId: "req-script-drift",
        messageIncludes: "approval script operand changed before execution",
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("releases Claude Bash when the approved script operand is unchanged", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-stable-"));
    const scriptPath = path.join(workspaceDir, "script.sh");
    try {
      await fs.writeFile(scriptPath, "#!/bin/sh\necho approved\n");
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "claude-native-script-stable" })
        .mockResolvedValueOnce({
          id: "claude-native-script-stable",
          decision: "allow-once",
        });
      const live = mockClaudeLiveRun(supervisorSpawnMock, {
        events: buildClaudeControlRequestEvents({
          requestId: "req-script-stable",
          toolUseId: "tool-script-stable",
          input: { command: "sh script.sh" },
          sessionId: "live-script-stable",
        }),
      });

      await executePreparedCliRun(
        buildClaudeLiveRunContext({
          workspaceDir,
          config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
        }),
      );

      await vi.waitFor(() =>
        expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
      );
      expectClaudeControlDecision(live, {
        behavior: "allow",
        requestId: "req-script-stable",
        toolUseId: "tool-script-stable",
        updatedInput: { command: "sh script.sh" },
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("sends full reviewer detail for oversized non-Bash tool input", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-bounded-detail",
      decision: "allow-once",
    });
    const content = `line one ${"x".repeat(500)} line end`;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-write-bounded-detail",
        toolUseId: "tool-write-bounded-detail-1",
        toolName: "Write",
        input: { file_path: "/tmp/out.txt", content },
        sessionId: "live-control-write-bounded-detail",
      }),
      pid: 3012,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-write-bounded-detail",
      toolUseId: "tool-write-bounded-detail-1",
      updatedInput: { file_path: "/tmp/out.txt", content },
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        detail: JSON.stringify({ file_path: "/tmp/out.txt", content }),
        allowedDecisions: ["allow-once", "deny"],
      }),
      { expectFinal: false },
    );
  });

  it("fails closed when a Claude native tool Gateway approval is unavailable", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-approval-unavailable",
        toolUseId: "tool-approval-unavailable-1",
        input: { command: "ls" },
        sessionId: "live-control-approval-unavailable",
      }),
      pid: 3013,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId: "req-approval-unavailable",
      messageIncludes: "OpenClaw approval was not granted",
    });
  });

  it("denies oversized Claude Bash approval requests before calling the Gateway", async () => {
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-bash-oversized",
        toolUseId: "tool-bash-oversized-1",
        input: { command: "x".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) },
        sessionId: "live-control-bash-oversized",
      }),
      pid: 3014,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId: "req-bash-oversized",
      messageIncludes: "too large to display",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("preserves loopback policy blocks for Claude live tools", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        event.toolCallId === "tool-live-blocked"
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    let captureKey = "";
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        emitClaudeInputStarted(stdoutListener, data);
        const captureHandle = markMcpLoopbackToolCallStarted({
          captureKey,
          toolName: "message",
          args: { action: "react" },
        });
        if (!captureHandle) {
          throw new Error("Expected live tool capture");
        }
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName: "message",
          args: { action: "react" },
          outcome: "blocked",
          deniedReason: "plugin-approval",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-blocked" }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-blocked",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-blocked",
                    name: "mcp__openclaw__message",
                    input: { action: "react" },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "user",
              session_id: "live-blocked",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-live-blocked",
                    content: "blocked",
                    is_error: true,
                  },
                ],
              },
            }),
            JSON.stringify({ type: "result", session_id: "live-blocked", result: "ok" }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    const liveRunLifecycle = createCancelableLiveRunLifecycle();
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        env?: Record<string, string>;
        onStdout?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      return { pid: 3061, startedAtMs: Date.now(), stdin, ...liveRunLifecycle };
    });
    const context = buildClaudeLiveRunContext({
      sessionId: "session-live-blocked",
      sessionKey: "agent:main:blocked",
      prompt: "hello",
    });
    context.mcpDeliveryCapture = true;

    try {
      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }

    expect(diagnosticEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "tool-live-blocked" },
      {
        type: "tool.execution.blocked",
        toolCallId: "tool-live-blocked",
        deniedReason: "plugin-approval",
      },
    ]);
    expect(liveRunLifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
  });
});
