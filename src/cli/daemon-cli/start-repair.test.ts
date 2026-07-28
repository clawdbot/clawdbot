// Start repair tests cover stale service repair install-plan wiring.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService, GatewayServiceState } from "../../daemon/service.js";

const buildGatewayInstallPlanMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      existingEnvironment?: Record<string, string | undefined>;
      existingEnvironmentValueSources?: Record<
        string,
        "inline" | "file" | "inline-and-file" | undefined
      >;
    }) => {
      const preservedFileValue =
        params.existingEnvironmentValueSources?.TELEGRAM_DEFAULT_BOTTOKEN === "file";
      return {
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp/openclaw",
        environment: {
          TELEGRAM_DEFAULT_BOTTOKEN: preservedFileValue
            ? params.existingEnvironment?.TELEGRAM_DEFAULT_BOTTOKEN
            : "placeholder-overwritten-token",
        },
        environmentValueSources: {
          TELEGRAM_DEFAULT_BOTTOKEN: preservedFileValue ? "file" : "inline",
        },
      };
    },
  ),
);
const resolveGatewayInstallTokenMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotForWriteMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn(() => 18789));
const resolveOpenClawWrapperPathMock = vi.hoisted(() => vi.fn());
const formatGatewayServiceStartRepairIssuesMock = vi.hoisted(() => vi.fn());
const defaultRuntimeLogMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: buildGatewayInstallPlanMock,
}));

vi.mock("../../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
}));

vi.mock("../../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken: resolveGatewayInstallTokenMock,
}));

vi.mock("../../config/io.js", () => ({
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
}));

vi.mock("../../config/paths.js", () => ({
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("../../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveOpenClawWrapperPath: resolveOpenClawWrapperPathMock,
}));

vi.mock("../../daemon/service.js", () => ({
  formatGatewayServiceStartRepairIssues: formatGatewayServiceStartRepairIssuesMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: defaultRuntimeLogMock },
}));

const { repairLoadedGatewayServiceForStart } = await import("./start-repair.js");

function readFirstInstallPlanArg(): Record<string, unknown> {
  const [firstArg] = buildGatewayInstallPlanMock.mock.calls[0] ?? [];
  if (!firstArg) {
    throw new Error("expected first install plan call");
  }
  return firstArg as Record<string, unknown>;
}

describe("repairLoadedGatewayServiceForStart", () => {
  beforeEach(() => {
    buildGatewayInstallPlanMock.mockClear();
    resolveGatewayInstallTokenMock.mockReset();
    readConfigFileSnapshotForWriteMock.mockReset();
    resolveGatewayPortMock.mockClear();
    resolveOpenClawWrapperPathMock.mockReset();
    formatGatewayServiceStartRepairIssuesMock.mockReset();
    defaultRuntimeLogMock.mockClear();

    resolveGatewayInstallTokenMock.mockResolvedValue({
      tokenRefConfigured: false,
      warnings: [],
    });
    readConfigFileSnapshotForWriteMock.mockResolvedValue({
      snapshot: { exists: true, valid: true, sourceConfig: {}, config: {} },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    resolveOpenClawWrapperPathMock.mockResolvedValue("/usr/bin/openclaw");
    formatGatewayServiceStartRepairIssuesMock.mockReturnValue(
      "service was installed by an older version",
    );
  });

  it("forwards existing env value-source metadata when repairing stale service definitions", async () => {
    const installMock = vi.fn(async () => {});
    const isLoadedMock = vi.fn(async () => true);
    const service = {
      install: installMock,
      isLoaded: isLoadedMock,
    } as unknown as GatewayService;
    const existingEnvironment = {
      OPENCLAW_SERVICE_VERSION: "2026.4.24",
      TELEGRAM_DEFAULT_BOTTOKEN: "existing-env-file-token",
    };
    const existingEnvironmentValueSources = {
      OPENCLAW_SERVICE_VERSION: "inline" as const,
      TELEGRAM_DEFAULT_BOTTOKEN: "file" as const,
    };
    const state: GatewayServiceState = {
      installed: true,
      loaded: true,
      running: false,
      env: {},
      command: {
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        environment: existingEnvironment,
        environmentValueSources: existingEnvironmentValueSources,
      },
    };

    await repairLoadedGatewayServiceForStart({
      service,
      state,
      issues: [{ code: "version-mismatch", message: "old service" }],
      json: true,
      stdout: process.stdout,
    });

    const planArg = readFirstInstallPlanArg();
    expect(planArg.existingEnvironment).toBe(existingEnvironment);
    expect(planArg.existingEnvironmentValueSources).toBe(existingEnvironmentValueSources);
    expect(installMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: { TELEGRAM_DEFAULT_BOTTOKEN: "existing-env-file-token" },
        environmentValueSources: { TELEGRAM_DEFAULT_BOTTOKEN: "file" },
      }),
    );
  });
});
