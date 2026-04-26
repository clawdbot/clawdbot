import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  readEmbeddedGatewayTokenForTest,
  testServiceAuditCodes,
} from "./doctor-service-audit.test-helpers.js";

const fsMocks = vi.hoisted(() => ({
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      realpath: fsMocks.realpath,
    },
    realpath: fsMocks.realpath,
  };
});

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  stage: vi.fn(),
  install: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
  auditGatewayServiceConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  resolveGatewayAuthTokenForService: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveIsNixMode: vi.fn(() => false),
  findExtraGatewayServices: vi.fn().mockResolvedValue([]),
  renderGatewayServiceCleanupHints: vi.fn().mockReturnValue([]),
  uninstallLegacySystemdUnits: vi.fn().mockResolvedValue([]),
  note: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: mocks.resolveGatewayPort,
  resolveIsNixMode: mocks.resolveIsNixMode,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    writeConfigFile: mocks.writeConfigFile,
  };
});

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices: mocks.findExtraGatewayServices,
  renderGatewayServiceCleanupHints: mocks.renderGatewayServiceCleanupHints,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: vi.fn().mockReturnValue(undefined),
  resolveSystemNodeInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: mocks.auditGatewayServiceConfig,
  needsNodeRuntimeMigration: vi.fn(() => false),
  readEmbeddedGatewayToken: readEmbeddedGatewayTokenForTest,
  SERVICE_AUDIT_CODES: {
    gatewayEntrypointMismatch: testServiceAuditCodes.gatewayEntrypointMismatch,
  },
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    readCommand: mocks.readCommand,
    stage: mocks.stage,
    install: mocks.install,
  }),
}));

vi.mock("../daemon/systemd.js", () => ({
  uninstallLegacySystemdUnits: mocks.uninstallLegacySystemdUnits,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

vi.mock("./doctor-gateway-auth-token.js", () => ({
  resolveGatewayAuthTokenForService: mocks.resolveGatewayAuthTokenForService,
}));

import {
  maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import { EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy.js";

const originalStdinIsTTY = process.stdin.isTTY;
const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

function makeDoctorIo() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function makeDoctorPrompts() {
  return {
    confirm: vi.fn().mockResolvedValue(true),
    confirmAutoFix: vi.fn().mockResolvedValue(true),
    confirmAggressiveAutoFix: vi.fn().mockResolvedValue(true),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue("node"),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

async function runRepair(cfg: OpenClawConfig) {
  await maybeRepairGatewayServiceConfig(cfg, "local", makeDoctorIo(), makeDoctorPrompts());
}

async function runNonInteractiveRepair(params: {
  cfg?: OpenClawConfig;
  updateInProgress?: boolean;
}) {
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  if (params.updateInProgress) {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  } else {
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  }
  await maybeRepairGatewayServiceConfig(
    params.cfg ?? { gateway: {} },
    "local",
    makeDoctorIo(),
    createDoctorPrompter({
      runtime: makeDoctorIo(),
      options: {
        repair: true,
        nonInteractive: true,
      },
    }),
  );
}

const gatewayProgramArguments = [
  "/usr/bin/node",
  "/usr/local/bin/openclaw",
  "gateway",
  "--port",
  "18789",
];

function createGatewayCommand(entrypoint: string) {
  return {
    programArguments: ["/usr/bin/node", entrypoint, "gateway", "--port", "18789"],
    environment: {},
  };
}

function setupGatewayEntrypointRepairScenario(params: {
  currentEntrypoint: string;
  installEntrypoint: string;
  installWorkingDirectory?: string;
  realpath?: (value: string) => Promise<string>;
  realpathError?: Error;
}) {
  mocks.readCommand.mockResolvedValue(createGatewayCommand(params.currentEntrypoint));
  mocks.auditGatewayServiceConfig.mockResolvedValue({
    ok: true,
    issues: [],
  });
  mocks.buildGatewayInstallPlan.mockResolvedValue({
    ...createGatewayCommand(params.installEntrypoint),
    ...(params.installWorkingDirectory ? { workingDirectory: params.installWorkingDirectory } : {}),
  });
  if (params.realpath) {
    fsMocks.realpath.mockImplementation(params.realpath);
  } else if (params.realpathError) {
    fsMocks.realpath.mockRejectedValue(params.realpathError);
  } else {
    fsMocks.realpath.mockImplementation(async (value: string) => value);
  }
}

function setupGatewayTokenRepairScenario() {
  mocks.readCommand.mockResolvedValue({
    programArguments: gatewayProgramArguments,
    environment: {
      OPENCLAW_GATEWAY_TOKEN: "stale-token",
    },
  });
  mocks.auditGatewayServiceConfig.mockResolvedValue({
    ok: false,
    issues: [
      {
        code: "gateway-token-mismatch",
        message: "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token",
        level: "recommended",
      },
    ],
  });
  mocks.buildGatewayInstallPlan.mockResolvedValue({
    programArguments: gatewayProgramArguments,
    workingDirectory: "/tmp",
    environment: {},
  });
  mocks.install.mockResolvedValue(undefined);
}

describe("maybeRepairGatewayServiceConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.realpath.mockImplementation(async (value: string) => value);
    mocks.resolveGatewayAuthTokenForService.mockImplementation(async (cfg: OpenClawConfig, env) => {
      const configToken =
        typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway.auth.token.trim() : undefined;
      const envToken = env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
      return { token: configToken || envToken };
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  it("treats gateway.auth.token as source of truth for service token repairs", async () => {
    setupGatewayTokenRepairScenario();

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "config-token",
        },
      },
    };

    await runRepair(cfg);

    expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGatewayToken: "config-token",
      }),
    );
    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: "config-token",
            }),
          }),
        }),
      }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("uses OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      setupGatewayTokenRepairScenario();

      const cfg: OpenClawConfig = {
        gateway: {},
      };

      await runRepair(cfg);

      expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedGatewayToken: "env-token",
        }),
      );
      expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            gateway: expect.objectContaining({
              auth: expect.objectContaining({
                token: "env-token",
              }),
            }),
          }),
        }),
      );
      expect(mocks.writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: "env-token",
            }),
          }),
        }),
      );
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.install).toHaveBeenCalledTimes(1);
    });
  });

  it("does not flag entrypoint mismatch when symlink and realpath match", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
      installEntrypoint:
        "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/openclaw@2026.3.12/node_modules/openclaw/dist/index.js",
      realpath: async (value: string) => {
        if (value.includes("/global/5/node_modules/openclaw/")) {
          return value.replace(
            "/global/5/node_modules/openclaw/",
            "/global/5/node_modules/.pnpm/openclaw@2026.3.12/node_modules/openclaw/",
          );
        }
        return value;
      },
    });

    await runRepair({ gateway: {} });

    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("does not flag entrypoint mismatch when realpath fails but normalized absolute paths match", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/opt/openclaw/../openclaw/dist/index.js",
      installEntrypoint: "/opt/openclaw/dist/index.js",
      realpathError: new Error("no realpath"),
    });

    await runRepair({ gateway: {} });

    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("still flags entrypoint mismatch when canonicalized paths differ", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint:
        "/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/openclaw/dist/index.js",
      installEntrypoint: "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
    });

    await runRepair({ gateway: {} });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("repairs entrypoint mismatch in non-interactive fix mode", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      installWorkingDirectory: "/tmp",
    });

    await runNonInteractiveRepair({
      cfg: { gateway: {} },
      updateInProgress: false,
    });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("stages service config repairs during non-interactive update repairs", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      installWorkingDirectory: "/tmp",
    });

    await runNonInteractiveRepair({
      cfg: { gateway: {} },
      updateInProgress: true,
    });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("treats SecretRef-managed gateway token as non-persisted service state", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-token",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.install.mockResolvedValue(undefined);

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_GATEWAY_TOKEN",
          },
        },
      },
    };

    await runRepair(cfg);

    expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGatewayToken: undefined,
      }),
    );
    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
      }),
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("falls back to embedded service token when config and env tokens are missing", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        setupGatewayTokenRepairScenario();

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedGatewayToken: undefined,
          }),
        );
        expect(mocks.writeConfigFile).toHaveBeenCalledWith(
          expect.objectContaining({
            gateway: expect.objectContaining({
              auth: expect.objectContaining({
                token: "stale-token",
              }),
            }),
          }),
        );
        expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              gateway: expect.objectContaining({
                auth: expect.objectContaining({
                  token: "stale-token",
                }),
              }),
            }),
          }),
        );
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("does not persist embedded service tokens during non-interactive update repairs", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        setupGatewayTokenRepairScenario();

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await maybeRepairGatewayServiceConfig(
          cfg,
          "local",
          makeDoctorIo(),
          createDoctorPrompter({
            runtime: makeDoctorIo(),
            options: {
              repair: true,
              nonInteractive: true,
            },
          }),
        );

        expect(mocks.writeConfigFile).not.toHaveBeenCalled();
        expect(mocks.stage).toHaveBeenCalledTimes(1);
        expect(mocks.install).not.toHaveBeenCalled();
      },
    );
  });

  it("does not persist EnvironmentFile-backed service tokens into config", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mocks.readCommand.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "env-file-token",
          },
          environmentValueSources: {
            OPENCLAW_GATEWAY_TOKEN: "file",
          },
        });
        mocks.auditGatewayServiceConfig.mockResolvedValue({
          ok: false,
          issues: [],
        });
        mocks.buildGatewayInstallPlan.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          workingDirectory: "/tmp",
          environment: {},
        });
        mocks.install.mockResolvedValue(undefined);

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expect(mocks.writeConfigFile).not.toHaveBeenCalled();
        expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
          expect.objectContaining({
            config: cfg,
          }),
        );
        expect(mocks.stage).not.toHaveBeenCalled();
      },
    );
  });

  it("reports service config drift but skips service rewrite when service repair policy is external", async () => {
    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      setupGatewayEntrypointRepairScenario({
        currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
        installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
        installWorkingDirectory: "/tmp",
      });

      await runRepair({ gateway: {} });

      expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledTimes(1);
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Gateway service entrypoint does not match the current install."),
        "Gateway service config",
      );
      expect(mocks.note).toHaveBeenCalledWith(
        EXTERNAL_SERVICE_REPAIR_NOTE,
        "Gateway service config",
      );
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
    });
  });
});

describe("maybeScanExtraGatewayServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findExtraGatewayServices.mockResolvedValue([]);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([]);
  });

  it("removes legacy Linux user systemd services", async () => {
    mocks.findExtraGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: "unit: /home/test/.config/systemd/user/clawdbot-gateway.service",
        scope: "user",
        legacy: true,
      },
    ]);
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([
      {
        name: "clawdbot-gateway",
        unitPath: "/home/test/.config/systemd/user/clawdbot-gateway.service",
        enabled: true,
        exists: true,
      },
    ]);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const prompter = {
      confirm: vi.fn(),
      confirmAutoFix: vi.fn(),
      confirmAggressiveAutoFix: vi.fn(),
      confirmRuntimeRepair: vi.fn().mockResolvedValue(true),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
      repairMode: {
        shouldRepair: false,
        shouldForce: false,
        nonInteractive: false,
        canPrompt: true,
        updateInProgress: false,
      },
    };

    await maybeScanExtraGatewayServices({ deep: false }, runtime, prompter);

    expect(mocks.uninstallLegacySystemdUnits).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallLegacySystemdUnits).toHaveBeenCalledWith({
      env: process.env,
      stdout: process.stdout,
    });
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("clawdbot-gateway.service"),
      "Legacy gateway removed",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Legacy gateway services removed. Installing OpenClaw gateway next.",
    );
  });

  it("reports legacy services but skips cleanup when service repair policy is external", async () => {
    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      mocks.findExtraGatewayServices.mockResolvedValue([
        {
          platform: "linux",
          label: "clawdbot-gateway.service",
          detail: "unit: /home/test/.config/systemd/user/clawdbot-gateway.service",
          scope: "user",
          legacy: true,
        },
      ]);

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());

      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("clawdbot-gateway.service"),
        "Other gateway-like services detected",
      );
      expect(mocks.note).toHaveBeenCalledWith(
        EXTERNAL_SERVICE_REPAIR_NOTE,
        "Legacy gateway cleanup skipped",
      );
      expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalledWith(
        "Legacy gateway services removed. Installing OpenClaw gateway next.",
      );
    });
  });
});
