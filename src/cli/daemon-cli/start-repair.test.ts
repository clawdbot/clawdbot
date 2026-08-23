// Start repair tests cover stale service repair install-plan wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const resolveGatewayPortMock = vi.hoisted(() =>
  vi.fn(
    (config: { gateway?: { port?: number } } | undefined, env: NodeJS.ProcessEnv = process.env) => {
      const portMatch = env.OPENCLAW_GATEWAY_PORT?.trim().match(/(?:^|:)(\d+)$/);
      return Number(portMatch?.[1]) || config?.gateway?.port || 18_789;
    },
  ),
);
const resolveStateDirMock = vi.hoisted(() =>
  vi.fn((env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR?.trim() || `${env.HOME}/.openclaw`),
);
const resolveConfigPathCandidateMock = vi.hoisted(() =>
  vi.fn(
    (env: NodeJS.ProcessEnv) =>
      env.OPENCLAW_CONFIG_PATH?.trim() ||
      `${env.OPENCLAW_STATE_DIR?.trim() || `${env.HOME}/.openclaw`}/openclaw.json`,
  ),
);
const resolveOpenClawWrapperPathMock = vi.hoisted(() => vi.fn());
const formatGatewayServiceStartRepairIssuesMock = vi.hoisted(() => vi.fn());
const defaultRuntimeLogMock = vi.hoisted(() => vi.fn());
const assertGatewayServiceMutationAllowedMock = vi.hoisted(() => vi.fn());

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
  resolveConfigPathCandidate: resolveConfigPathCandidateMock,
  resolveGatewayPort: resolveGatewayPortMock,
  resolveStateDir: resolveStateDirMock,
}));

vi.mock("../../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveOpenClawWrapperPath: resolveOpenClawWrapperPathMock,
}));

vi.mock("../../daemon/service.js", () => ({
  formatGatewayServiceStartRepairIssues: formatGatewayServiceStartRepairIssuesMock,
}));

vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: assertGatewayServiceMutationAllowedMock,
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
    vi.stubEnv("HOME", "/home/openclaw");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
    vi.stubEnv("OPENCLAW_HOME", "");
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    buildGatewayInstallPlanMock.mockClear();
    resolveGatewayInstallTokenMock.mockReset();
    readConfigFileSnapshotForWriteMock.mockReset();
    resolveGatewayPortMock.mockClear();
    resolveOpenClawWrapperPathMock.mockReset();
    formatGatewayServiceStartRepairIssuesMock.mockReset();
    defaultRuntimeLogMock.mockClear();
    assertGatewayServiceMutationAllowedMock.mockReset();

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
      "service port does not match current gateway config",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops legacy version metadata when repairing genuine service drift", async () => {
    const installMock = vi.fn(async () => {});
    const isLoadedMock = vi.fn(async () => true);
    const service = {
      install: installMock,
      isLoaded: isLoadedMock,
    } as unknown as GatewayService;
    const existingEnvironment = {
      HOME: "/home/openclaw",
      OPENCLAW_SERVICE_VERSION: "2026.4.24",
      TELEGRAM_DEFAULT_BOTTOKEN: "existing-env-file-token",
    };
    const existingEnvironmentValueSources = {
      OPENCLAW_SERVICE_VERSION: "inline" as const,
      TELEGRAM_DEFAULT_BOTTOKEN: "file" as const,
    };
    const state: GatewayServiceState = {
      installed: true,
      loadState: { status: "loaded" },
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
      issues: [{ code: "port-mismatch", message: "old port" }],
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

  it.each(["start", "restart"] as const)(
    "refuses %s repair when ambient state, config, and port target a different service",
    async (action) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/stress-state");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", "/home/openclaw/stress-state/openclaw.json");
      readConfigFileSnapshotForWriteMock.mockResolvedValue({
        snapshot: {
          exists: true,
          valid: true,
          sourceConfig: { gateway: { port: 18_999 } },
          config: { gateway: { port: 18_999 } },
        },
        writeOptions: { expectedConfigPath: "/home/openclaw/stress-state/openclaw.json" },
      });

      const originalUnit = [
        "ExecStart=/usr/bin/openclaw gateway --port 18789",
        "EnvironmentFile=-/home/openclaw/.openclaw/gateway.systemd.env",
        "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENAI_API_KEY,OPENCLAW_GATEWAY_PASSWORD",
      ].join("\n");
      let unit = originalUnit;
      const installMock = vi.fn(async () => {
        unit = "rewritten";
      });
      const service = {
        install: installMock,
        isLoaded: vi.fn(async () => true),
      } as unknown as GatewayService;
      const state: GatewayServiceState = {
        installed: true,
        loadState: { status: "loaded" },
        running: false,
        env: {},
        command: {
          programArguments: ["/usr/bin/openclaw", "gateway", "--port", "18789"],
          environment: {
            HOME: "/home/openclaw",
            OPENAI_API_KEY: "file-backed-openai-key",
            OPENCLAW_GATEWAY_PASSWORD: "file-backed-password",
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY,OPENCLAW_GATEWAY_PASSWORD",
          },
          environmentValueSources: {
            HOME: "inline",
            OPENAI_API_KEY: "file",
            OPENCLAW_GATEWAY_PASSWORD: "file",
            OPENCLAW_GATEWAY_PORT: "inline",
            OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "inline",
          },
        },
      };

      const repairParams = {
        service,
        state,
        issues: [{ code: "port-mismatch" as const, message: "old port" }],
        json: true,
        stdout: process.stdout,
      };
      const repair =
        action === "restart"
          ? repairLoadedGatewayServiceForStart({ ...repairParams, action })
          : repairLoadedGatewayServiceForStart(repairParams);
      await expect(repair).rejects.toThrow(
        [
          "Refusing to repair the managed Gateway service because the current invocation targets a different Gateway:",
          '- OPENCLAW_STATE_DIR: installed="/home/openclaw/.openclaw", ambient="/home/openclaw/stress-state"',
          '- OPENCLAW_CONFIG_PATH: installed="/home/openclaw/.openclaw/openclaw.json", ambient="/home/openclaw/stress-state/openclaw.json"',
          '- gateway.port: installed="18789", ambient="18999"',
          `Run \`openclaw gateway ${action}\` with the installed state directory, config path, and port (or unset conflicting environment overrides). To retarget intentionally, run \`openclaw gateway install --force\`.`,
        ].join("\n"),
      );

      expect(unit).toBe(originalUnit);
      expect(installMock).not.toHaveBeenCalled();
      expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
      expect(resolveGatewayInstallTokenMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a port-less stale service repair when ambient port overrides its config port", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18999");
    readConfigFileSnapshotForWriteMock.mockResolvedValue({
      snapshot: {
        exists: true,
        valid: true,
        sourceConfig: { gateway: { port: 18_789 } },
        config: { gateway: { port: 18_789 } },
      },
      writeOptions: { expectedConfigPath: "/home/openclaw/.openclaw/openclaw.json" },
    });
    const installMock = vi.fn(async () => {});
    const service = {
      install: installMock,
      isLoaded: vi.fn(async () => true),
    } as unknown as GatewayService;
    const state: GatewayServiceState = {
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      env: {},
      command: {
        programArguments: ["/usr/bin/openclaw", "gateway"],
        environment: { HOME: "/home/openclaw" },
      },
    };

    await expect(
      repairLoadedGatewayServiceForStart({
        service,
        state,
        issues: [{ code: "port-mismatch", message: "old port" }],
        json: true,
        stdout: process.stdout,
      }),
    ).rejects.toThrow('- gateway.port: installed="18789", ambient="18999"');

    expect(installMock).not.toHaveBeenCalled();
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
  });

  it("resolves installed host-and-port environment syntax before comparing repair targets", async () => {
    const installMock = vi.fn(async () => {});
    const service = {
      install: installMock,
      isLoaded: vi.fn(async () => true),
    } as unknown as GatewayService;
    const state: GatewayServiceState = {
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      env: {},
      command: {
        programArguments: ["/usr/bin/openclaw", "gateway"],
        environment: {
          HOME: "/home/openclaw",
          OPENCLAW_GATEWAY_PORT: "127.0.0.1:19000",
        },
      },
    };

    await expect(
      repairLoadedGatewayServiceForStart({
        service,
        state,
        issues: [{ code: "port-mismatch", message: "old port" }],
        json: true,
        stdout: process.stdout,
      }),
    ).rejects.toThrow('- gateway.port: installed="19000", ambient="18789"');

    expect(installMock).not.toHaveBeenCalled();
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
  });

  it("refuses repair when a legacy service does not identify its installed state directory", async () => {
    vi.stubEnv("HOME", "/home/ambient-user");
    const installMock = vi.fn(async () => {});
    const service = {
      install: installMock,
      isLoaded: vi.fn(async () => true),
    } as unknown as GatewayService;
    const state: GatewayServiceState = {
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      env: {},
      command: {
        programArguments: ["/usr/bin/openclaw", "gateway", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      },
    };

    await expect(
      repairLoadedGatewayServiceForStart({
        service,
        state,
        issues: [{ code: "missing-program", message: "missing program" }],
        json: true,
        stdout: process.stdout,
      }),
    ).rejects.toThrow("installed state directory cannot be determined");

    expect(installMock).not.toHaveBeenCalled();
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
  });
});
