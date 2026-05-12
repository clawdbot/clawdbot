import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";

const commandExplainerMock = vi.hoisted(() => ({
  importCount: 0,
  explainShellCommand: vi.fn(async (command: string): Promise<string> => command),
  formatCommandSpans: vi.fn((command: string) => {
    if (command.startsWith("pwsh ") || command.startsWith("cmd.exe ")) {
      return [];
    }
    if (command.startsWith("node ")) {
      return [{ startIndex: 0, endIndex: 4 }];
    }
    return [
      { startIndex: 0, endIndex: 2 },
      { startIndex: 0, endIndex: 4 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 20, endIndex: 26 },
    ];
  }),
}));

vi.mock("../infra/command-explainer/index.js", () => {
  commandExplainerMock.importCount += 1;
  return {
    explainShellCommand: commandExplainerMock.explainShellCommand,
    formatCommandSpans: commandExplainerMock.formatCommandSpans,
  };
});

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let requestExecApprovalDecision: typeof import("./bash-tools.exec-approval-request.js").requestExecApprovalDecision;
let registerExecApprovalRequestForHost: typeof import("./bash-tools.exec-approval-request.js").registerExecApprovalRequestForHost;

const initialProcessPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

function restoreProcessPlatformForTest(): void {
  if (initialProcessPlatform) {
    Object.defineProperty(process, "platform", initialProcessPlatform);
  }
}

type ApprovalRequestPayload = {
  commandSpans?: Array<{ startIndex: number; endIndex: number }>;
};

function requireApprovalRequestPayload(callIndex: number): ApprovalRequestPayload {
  const call = vi.mocked(callGatewayTool).mock.calls[callIndex];
  expect(call?.[0]).toBe("exec.approval.request");
  const payload = call?.[2];
  if (!payload || typeof payload !== "object") {
    throw new Error(`expected approval request payload ${callIndex}`);
  }
  return payload as ApprovalRequestPayload;
}

describe("requestExecApprovalDecision", () => {
  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ requestExecApprovalDecision, registerExecApprovalRequestForHost } =
      await import("./bash-tools.exec-approval-request.js"));
  });

  beforeEach(() => {
    vi.mocked(callGatewayTool).mockClear();
    commandExplainerMock.explainShellCommand.mockClear();
    commandExplainerMock.formatCommandSpans.mockClear();
    restoreProcessPlatformForTest();
  });

  afterEach(() => {
    restoreProcessPlatformForTest();
  });

  it("does not load the command explainer when importing approval requests", () => {
    expect(commandExplainerMock.importCount).toBe(0);
  });

  it("returns string decisions", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        status: "accepted",
        id: "approval-id",
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      })
      .mockResolvedValueOnce({ decision: "allow-once" });

    const result = await requestExecApprovalDecision({
      id: "approval-id",
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      security: "allowlist",
      ask: "always",
      agentId: "main",
      resolvedPath: "/usr/bin/echo",
      sessionKey: "session",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+15555550123",
      turnSourceAccountId: "work",
      turnSourceThreadId: "1739201675.123",
    });

    expect(result).toBe("allow-once");
    expect(callGatewayTool).toHaveBeenCalledWith(
      "exec.approval.request",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      {
        id: "approval-id",
        command: "echo hi",
        cwd: "/tmp",
        nodeId: undefined,
        host: "gateway",
        security: "allowlist",
        ask: "always",
        agentId: "main",
        resolvedPath: "/usr/bin/echo",
        sessionKey: "session",
        turnSourceChannel: "whatsapp",
        turnSourceTo: "+15555550123",
        turnSourceAccountId: "work",
        turnSourceThreadId: "1739201675.123",
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        twoPhase: true,
      },
      { expectFinal: false },
    );
    expect(callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      { id: "approval-id" },
    );
  });

  it("returns null for missing or non-string decisions", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ status: "accepted", id: "approval-id", expiresAtMs: 1234 })
      .mockResolvedValueOnce({});
    await expect(
      requestExecApprovalDecision({
        id: "approval-id",
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBeNull();

    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ status: "accepted", id: "approval-id-2", expiresAtMs: 1234 })
      .mockResolvedValueOnce({ decision: 123 });
    await expect(
      requestExecApprovalDecision({
        id: "approval-id-2",
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBeNull();
  });

  it("uses registration response id when waiting for decision", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        status: "accepted",
        id: "server-assigned-id",
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      })
      .mockResolvedValueOnce({ decision: "allow-once" });

    await expect(
      requestExecApprovalDecision({
        id: "client-id",
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBe("allow-once");

    expect(callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      { id: "server-assigned-id" },
    );
  });

  it("treats expired-or-missing waitDecision as null decision", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        status: "accepted",
        id: "approval-id",
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      })
      .mockRejectedValueOnce(new Error("approval expired or not found"));

    await expect(
      requestExecApprovalDecision({
        id: "approval-id",
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).resolves.toBeNull();
  });

  it("returns final decision directly when gateway already replies with decision", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ decision: "deny", id: "approval-id" });

    const result = await requestExecApprovalDecision({
      id: "approval-id",
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      security: "allowlist",
      ask: "on-miss",
    });

    expect(result).toBe("deny");
    expect(vi.mocked(callGatewayTool).mock.calls).toStrictEqual([
      [
        "exec.approval.request",
        { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
        {
          ask: "on-miss",
          command: "echo hi",
          commandSpans: undefined,
          cwd: "/tmp",
          env: undefined,
          host: "gateway",
          id: "approval-id",
          nodeId: undefined,
          resolvedPath: undefined,
          security: "allowlist",
          sessionKey: undefined,
          systemRunPlan: undefined,
          timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
          twoPhase: true,
          turnSourceAccountId: undefined,
          turnSourceChannel: undefined,
          turnSourceThreadId: undefined,
          turnSourceTo: undefined,
          warningText: undefined,
          agentId: undefined,
        },
        { expectFinal: false },
      ],
    ]);
  });

  it("adds command spans to host approval registration payloads", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id",
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      commandHighlighting: true,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toStrictEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 0, endIndex: 4 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 20, endIndex: 26 },
    ]);
  });

  it("does not generate command spans by default", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id",
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.explainShellCommand).not.toHaveBeenCalled();
    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toBeUndefined();
  });

  it("does not generate command spans when command highlighting is disabled", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id",
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      commandHighlighting: false,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.explainShellCommand).not.toHaveBeenCalled();
    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toBeUndefined();
  });

  it("uses system run plan command text for host approval explanations", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id",
      systemRunPlan: {
        argv: ["node", "-e", "console.log(1)"],
        cwd: "/tmp/project",
        commandText: 'node -e "console.log(1)"',
        agentId: null,
        sessionKey: null,
      },
      commandHighlighting: true,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toStrictEqual([{ startIndex: 0, endIndex: 4 }]);
  });

  it("omits generated command spans for unsupported shell wrapper languages", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id-powershell",
      command: 'pwsh -Command "Get-ChildItem"',
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });
    await registerExecApprovalRequestForHost({
      approvalId: "approval-id-cmd",
      command: 'cmd.exe /d /s /c "dir"',
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(vi.mocked(callGatewayTool).mock.calls).toHaveLength(2);
    expect(requireApprovalRequestPayload(0).commandSpans).toBeUndefined();
    expect(requireApprovalRequestPayload(1).commandSpans).toBeUndefined();
  });

  it("omits generated command spans for Windows gateway PowerShell commands", async () => {
    setProcessPlatformForTest("win32");
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id-powershell",
      command:
        'Set-Content -Path "windows-agent-proof.txt" -Value "WINDOWS_AGENT_EXEC_OK" -NoNewline',
      workdir: "C:\\project",
      host: "gateway",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    expect(vi.mocked(callGatewayTool).mock.calls).toHaveLength(1);
    expect(requireApprovalRequestPayload(0).commandSpans).toBeUndefined();
  });

  it("omits generated command spans for unsupported shell wrappers through system run carriers", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id-carrier",
      systemRunPlan: {
        argv: ["timeout", "5", "pwsh", "-Command", "Get-ChildItem"],
        cwd: "/tmp/project",
        commandText: 'timeout 5 pwsh -Command "Get-ChildItem"',
        agentId: null,
        sessionKey: null,
      },
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    expect(vi.mocked(callGatewayTool).mock.calls).toHaveLength(1);
    expect(requireApprovalRequestPayload(0).commandSpans).toBeUndefined();
  });

  it("keeps explicit command spans", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHost({
      approvalId: "approval-id",
      command: "echo hi",
      commandSpans: [{ startIndex: 0, endIndex: 4 }],
      commandHighlighting: true,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toEqual([{ startIndex: 0, endIndex: 4 }]);
  });
});
