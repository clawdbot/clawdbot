import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { buildCommandTestParams } from "../commands.test-harness.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
}));

const hostCapabilityMocks = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(),
  createPermissionHandler: vi.fn(),
  permissionHandler: vi.fn(),
}));

const admissionMocks = vi.hoisted(() => ({
  admit: vi.fn(),
  close: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  resolveApprovalOwner: vi.fn(),
}));

vi.mock("../../../acp/runtime/registry.js", () => ({
  resolveAcpRuntimeApprovalOwnerPluginId: (backendId?: string) =>
    registryMocks.resolveApprovalOwner(backendId),
}));

vi.mock("../../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => managerMocks,
}));

vi.mock("../../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: () => null,
  resolveAcpAgentPolicyError: () => null,
  isAcpEnabledByPolicy: () => true,
  resolveAcpDispatchPolicyMessage: () => undefined,
}));

vi.mock("../../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: (requestId: string) => ({ requestId }),
  prepareAgentRunAdmission: () => ({
    admit: admissionMocks.admit,
  }),
  closeAdmittedRunDelegatedAuthority: (...args: unknown[]) => admissionMocks.close(...args),
}));

vi.mock("../../../agents/harness/host-capability.js", () => ({
  createAgentHarnessHostCapabilities: (params: unknown) => hostCapabilityMocks.create(params),
}));

vi.mock("../acp-permission-handler.js", () => ({
  createAcpPermissionHandler: (params: unknown) =>
    hostCapabilityMocks.createPermissionHandler(params),
}));

vi.mock("../channel-run-admission.js", () => ({
  consumeChannelRunAdmission: () => ({
    ingressState: "present",
    facts: {},
    onAdmitted: undefined,
  }),
}));

vi.mock("./targets.js", () => ({
  resolveAcpTargetSessionKey: async () => ({
    ok: true as const,
    sessionKey: "agent:main:acp:child",
  }),
}));

vi.mock("../../../acp/control-plane/manager.utils.js", () => ({
  resolveAcpSessionResolutionError: () => null,
}));

describe("handleAcpSteerAction permission bridge", () => {
  beforeEach(() => {
    managerMocks.resolveSession.mockReset();
    managerMocks.resolveSession.mockReturnValue({ kind: "ready", meta: { backend: "acpx" } });
    registryMocks.resolveApprovalOwner.mockReset();
    // Only a backend that declared an approval owner gets one back.
    registryMocks.resolveApprovalOwner.mockImplementation((backendId?: string) =>
      backendId === "acpx" ? "acpx" : null,
    );
    managerMocks.runTurn.mockReset();
    managerMocks.runTurn.mockResolvedValue(undefined);
    admissionMocks.admit.mockReset();
    admissionMocks.admit.mockResolvedValue({ kind: "admitted-run" });
    admissionMocks.close.mockReset();
    hostCapabilityMocks.close.mockReset();
    hostCapabilityMocks.create.mockReset();
    hostCapabilityMocks.create.mockReturnValue({
      capabilities: { kind: "agent-harness-host-capability", version: 1 },
      close: hostCapabilityMocks.close,
    });
    hostCapabilityMocks.createPermissionHandler.mockReset();
    hostCapabilityMocks.createPermissionHandler.mockReturnValue(
      hostCapabilityMocks.permissionHandler,
    );
    hostCapabilityMocks.permissionHandler.mockReset();
  });

  it("binds /acp steer turns to a host-owned permission handler", async () => {
    const { handleAcpSteerAction } = await import("./lifecycle.js");
    const params = buildCommandTestParams(" /acp steer child run ls", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      To: "channel:C123",
      AccountId: "workspace-1",
      ApprovalReviewerDeviceId: "device-1",
      MessageThreadId: "1724353200.123456",
    });
    params.sessionKey = "agent:main:slack:channel:C123";
    params.command.channel = "slack";
    params.command.accountId = "workspace-1";

    const result = await handleAcpSteerAction(params, ["--session", "child", "run", "ls"]);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("ACP steer sent to agent:main:acp:child");
    expect(managerMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:acp:child",
        mode: "steer",
        onPermissionRequest: hostCapabilityMocks.permissionHandler,
      }),
    );
    expect(hostCapabilityMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "acpx",
        attempt: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:C123",
          agentId: "main",
          messageChannel: "slack",
          currentMessagingTarget: "channel:C123",
          agentAccountId: "workspace-1",
          approvalReviewerDeviceId: "device-1",
        }),
      }),
    );
    expect(hostCapabilityMocks.createPermissionHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        host: { kind: "agent-harness-host-capability", version: 1 },
      }),
    );
    expect(hostCapabilityMocks.close).toHaveBeenCalledOnce();
    expect(admissionMocks.close).toHaveBeenCalledOnce();
  });

  it("does not attribute a non-ACPX backend's steer approvals to ACPX", async () => {
    // Any plugin can register an ACP backend. One that declared no approval
    // owner must not borrow ACPX's approval policy and audit identity, so the
    // permission bridge stays closed instead of falling back to a fixed id.
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      meta: { backend: "rogue-backend" },
    });

    const { handleAcpSteerAction } = await import("./lifecycle.js");
    const params = buildCommandTestParams(" /acp steer child run ls", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      To: "channel:C123",
      AccountId: "workspace-1",
    });
    params.sessionKey = "agent:main:slack:channel:C123";

    await handleAcpSteerAction(params, ["--session", "child", "run", "ls"]);

    expect(hostCapabilityMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "rogue-backend" }),
    );
    expect(hostCapabilityMocks.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "acpx" }),
    );
    expect(hostCapabilityMocks.createPermissionHandler).not.toHaveBeenCalled();
    expect(managerMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ onPermissionRequest: undefined }),
    );
  });

  it("forwards the command abort signal so a cancelled steer cannot honor a later approval", async () => {
    const { handleAcpSteerAction } = await import("./lifecycle.js");
    const controller = new AbortController();
    let approvalResolved: string | undefined;

    // Model the real ordering: the harness asks for permission mid-turn, the
    // operator clicks allow only after the command was cancelled.
    managerMocks.runTurn.mockImplementation(async (input: { signal?: AbortSignal }) => {
      controller.abort();
      approvalResolved = input.signal?.aborted ? "rejected-by-cancellation" : "allowed";
    });

    const params = buildCommandTestParams(" /acp steer child run ls", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      To: "channel:C123",
      AccountId: "workspace-1",
    });
    params.sessionKey = "agent:main:slack:channel:C123";
    params.commandInvocationSignal = controller.signal;

    await handleAcpSteerAction(params, ["--session", "child", "run", "ls"]);

    expect(managerMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(approvalResolved).toBe("rejected-by-cancellation");
    expect(hostCapabilityMocks.close).toHaveBeenCalledOnce();
    expect(admissionMocks.close).toHaveBeenCalledOnce();
  });
});
