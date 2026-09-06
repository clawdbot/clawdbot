import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorPrompter } from "./doctor-prompter.js";

const mocks = vi.hoisted(() => ({
  buildGatewayInstallPlan: vi.fn(),
  install: vi.fn(),
  note: vi.fn(),
  readGatewayServiceCommandForMutation: vi.fn(),
  restart: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));

vi.mock("../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd.js")>()),
  isLaunchAgentLoaded: vi.fn(async () => false),
  launchAgentPlistExists: vi.fn(async () => false),
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  readGatewayServiceCommandForMutation: mocks.readGatewayServiceCommandForMutation,
  readGatewayServiceState: vi.fn(async () => ({
    loadState: { status: "not-loaded" as const },
    runtime: { status: "stopped" as const },
    env: process.env,
  })),
  resolveGatewayService: () => ({
    install: mocks.install,
    restart: mocks.restart,
  }),
}));

vi.mock("../gateway/net.js", () => ({
  resolveGatewayBindHost: vi.fn(async () => "127.0.0.1"),
  resolveGatewayRequiredListenHosts: () => ["127.0.0.1"],
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortConnections: vi.fn(),
  inspectPortUsage: vi.fn(async () => ({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  })),
}));

vi.mock("../infra/ports-format.js", () => ({
  formatPortDiagnostics: vi.fn(() => []),
  isExpectedGatewayListeners: vi.fn(() => false),
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken: vi.fn(async () => ({
    tokenRefConfigured: false,
    warnings: [],
  })),
}));

import { maybeRepairGatewayDaemon } from "./doctor-gateway-daemon-flow.js";

function makePrompter(): DoctorPrompter {
  return {
    confirm: vi.fn(async () => true),
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => true),
    confirmRuntimeRepair: vi.fn(async () => true),
    select: async (_params, fallback) => fallback,
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      canPrompt: true,
      nonInteractive: false,
      updateInProgress: false,
    },
  };
}

async function runRepair() {
  return await maybeRepairGatewayDaemon({
    cfg: { gateway: {} },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: makePrompter(),
    options: { deep: false },
    gatewayDetailsMessage: "details",
    healthOk: false,
  });
}

describe("Doctor Gateway install failures", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    vi.clearAllMocks();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", {
        ...originalPlatformDescriptor,
        value: "darwin",
      });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("routes an unreadable migrated LaunchAgent through install failure guidance", async () => {
    mocks.readGatewayServiceCommandForMutation.mockRejectedValueOnce(
      new Error("existing service definition is unreadable"),
    );

    await runRepair();

    expect(mocks.note).toHaveBeenCalledWith(
      "Gateway service install failed: Error: existing service definition is unreadable",
      "Gateway",
    );
    expect(mocks.note).toHaveBeenCalledWith("hint", "Gateway");
    expect(mocks.readGatewayServiceCommandForMutation).toHaveBeenCalledOnce();
    expect(mocks.buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("preserves install planning failures", async () => {
    const planningError = new Error("install planning failed");
    mocks.readGatewayServiceCommandForMutation.mockResolvedValueOnce({
      kind: "missing",
      command: null,
    });
    mocks.buildGatewayInstallPlan.mockRejectedValueOnce(planningError);

    await expect(runRepair()).rejects.toBe(planningError);

    expect(mocks.readGatewayServiceCommandForMutation).toHaveBeenCalledOnce();
    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("retains relocated LaunchAgent heap ownership when reinstalling a disabled service", async () => {
    const existingCommand = {
      programArguments: [
        "node",
        "--max-old-space-size=4096",
        "/opt/openclaw/dist/index.js",
        "gateway",
      ],
      environment: { NODE_OPTIONS: "" },
    };
    mocks.readGatewayServiceCommandForMutation.mockResolvedValueOnce({
      kind: "relocated",
      plistPath: "/external/Library/LaunchAgents/ai.openclaw.gateway.plist",
      command: existingCommand,
    });
    mocks.buildGatewayInstallPlan.mockResolvedValueOnce({
      programArguments: existingCommand.programArguments,
      environment: existingCommand.environment,
    });

    await runRepair();

    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ existingCommand }),
    );
    expect(mocks.readGatewayServiceCommandForMutation).toHaveBeenCalledOnce();
    expect(mocks.buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty(
      "existingEnvironment",
    );
    expect(mocks.install).toHaveBeenCalledOnce();
  });
});
