/**
 * Exec approval request tests.
 * Covers two-phase gateway registration, decision waiting, timeout fallback,
 * and lazy command highlighting for host/node approval payloads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";

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
let registerExecApprovalRequestForHostOrThrow: typeof import("./bash-tools.exec-approval-request.js").registerExecApprovalRequestForHostOrThrow;

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
  approvalReviewerDeviceIds?: string[];
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

describe("exec approval requests", () => {
  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ registerExecApprovalRequestForHostOrThrow } =
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

  it("bounds missing registration expiries when the process clock is invalid", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id" });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);

    try {
      await expect(
        registerExecApprovalRequestForHostOrThrow({
          approvalId: "approval-id",
          command: "echo hi",
          workdir: "/tmp",
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
        }),
      ).resolves.toMatchObject({ expiresAtMs: 0 });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("replaces invalid gateway registration expiries with a bounded fallback", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({
      id: "approval-id",
      expiresAtMs: Number.MAX_VALUE,
    });
    const nowMs = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      await expect(
        registerExecApprovalRequestForHostOrThrow({
          approvalId: "approval-id",
          command: "echo hi",
          workdir: "/tmp",
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
        }),
      ).resolves.toMatchObject({ expiresAtMs: nowMs + DEFAULT_APPROVAL_TIMEOUT_MS });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("adds command spans to host approval registration payloads", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHostOrThrow({
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

  it("passes approval reviewer devices into host approval registration payloads", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHostOrThrow({
      approvalId: "approval-id",
      command: "echo hi",
      approvalReviewerDeviceIds: ["device-ios-reviewer"],
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    const payload = requireApprovalRequestPayload(0);
    expect(payload?.approvalReviewerDeviceIds).toEqual(["device-ios-reviewer"]);
  });

  it("does not generate command spans by default", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs: 1234 });

    await registerExecApprovalRequestForHostOrThrow({
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

    await registerExecApprovalRequestForHostOrThrow({
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

    await registerExecApprovalRequestForHostOrThrow({
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

    await registerExecApprovalRequestForHostOrThrow({
      approvalId: "approval-id-powershell",
      command: 'pwsh -Command "Get-ChildItem"',
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });
    await registerExecApprovalRequestForHostOrThrow({
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

    await registerExecApprovalRequestForHostOrThrow({
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

    await registerExecApprovalRequestForHostOrThrow({
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

    await registerExecApprovalRequestForHostOrThrow({
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
