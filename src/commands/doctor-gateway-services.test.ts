import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  replaceConfigFile: vi.fn().mockResolvedValue(undefined),
  auditGatewayServiceConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  resolveGatewayAuthTokenForService: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveIsNixMode: vi.fn(() => false),
  findExtraGatewayServices: vi.fn().mockResolvedValue([]),
  renderGatewayServiceCleanupHints: vi.fn().mockReturnValue([]),
  needsNodeRuntimeMigration: vi.fn(() => false),
  renderSystemNodeWarning: vi.fn().mockReturnValue(undefined),
  resolveSystemNodeInfo: vi.fn().mockResolvedValue(null),
  isSystemdUnitActive: vi.fn().mockResolvedValue(false),
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
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices: mocks.findExtraGatewayServices,
  renderGatewayServiceCleanupHints: mocks.renderGatewayServiceCleanupHints,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
}));

vi.mock("../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: mocks.auditGatewayServiceConfig,
  needsNodeRuntimeMigration: mocks.needsNodeRuntimeMigration,
  readEmbeddedGatewayToken: readEmbeddedGatewayTokenForTest,
  SERVICE_AUDIT_CODES: {
    gatewayCommandMissing: testServiceAuditCodes.gatewayCommandMissing,
    gatewayEntrypointMismatch: testServiceAuditCodes.gatewayEntrypointMismatch,
    gatewayManagedEnvEmbedded: testServiceAuditCodes.gatewayManagedEnvEmbedded,
    gatewayPortMismatch: testServiceAuditCodes.gatewayPortMismatch,
    gatewayProxyEnvEmbedded: testServiceAuditCodes.gatewayProxyEnvEmbedded,
    gatewayTokenMismatch: testServiceAuditCodes.gatewayTokenMismatch,
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
  isSystemdUnitActive: mocks.isSystemdUnitActive,
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
const originalPlatform = process.platform;
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

function mockProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function callArg(mock: { mock: { calls: Array<Array<unknown>> } }, index: number, label: string) {
  const call = mock.mock.calls.at(index);
  expect(call, label).toBeDefined();
  return call?.[0];
}

function expectCallField(
  mock: { mock: { calls: Array<Array<unknown>> } },
  field: string,
  expected: unknown,
) {
  const options = requireRecord(callArg(mock, 0, `first ${field} call`), field);
  expect(options[field]).toEqual(expected);
  return options;
}

function expectGatewayAuthToken(value: unknown, expected: string) {
  const root = requireRecord(value, "config root");
  const gateway = requireRecord(root.gateway, "config.gateway");
  const auth = requireRecord(gateway.auth, "config.gateway.auth");
  expect(auth.token).toBe(expected);
}

function readGatewayAuthToken(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const root = value as Record<string, unknown>;
  const gateway = root.gateway;
  if (!gateway || typeof gateway !== "object") {
    return undefined;
  }
  const auth = (gateway as Record<string, unknown>).auth;
  if (!auth || typeof auth !== "object") {
    return undefined;
  }
  return (auth as Record<string, unknown>).token;
}

function expectCallConfigGatewayAuthToken(
  mock: { mock: { calls: Array<Array<unknown>> } },
  expected: string,
) {
  const matched = mock.mock.calls.some(([value]) => {
    const options = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return readGatewayAuthToken(options.config) === expected;
  });
  expect(matched).toBe(true);
}

function expectNoteContaining(messagePart: string, title: string) {
  const messages = mocks.note.mock.calls
    .filter(([, callTitle]) => callTitle === title)
    .map(([message]) => String(message));
  expect(messages.some((message) => message.includes(messagePart))).toBe(true);
}

function expectNoNoteContaining(messagePart: string, title: string) {
  const messages = mocks.note.mock.calls
    .filter(([, callTitle]) => callTitle === title)
    .map(([message]) => String(message));
  expect(messages.some((message) => message.includes(messagePart))).toBe(false);
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
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.needsNodeRuntimeMigration.mockReturnValue(false);
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.isSystemdUnitActive.mockResolvedValue(false);
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
    mockProcessPlatform(originalPlatform);
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

    expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", "config-token");
    expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "config-token");
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate gateway runtime warnings already emitted by the node install plan", async () => {
    const nvmNode = "/home/orin/.nvm/versions/node/v22.22.2/bin/node";
    mocks.readCommand.mockResolvedValue({
      programArguments: [nvmNode, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ warn }) => {
      warn?.(
        "System Node 20.20.2 at /usr/bin/node is below the required Node 22.16+. Using /home/orin/.nvm/versions/node/v22.22.2/bin/node for the daemon.",
        "Gateway runtime",
      );
      return {
        programArguments: [nvmNode, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
        workingDirectory: "/tmp",
        environment: {},
      };
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [{ code: "runtime", message: "runtime migration", level: "recommended" }],
    });
    mocks.needsNodeRuntimeMigration.mockReturnValue(true);
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      version: "20.20.2",
      supported: false,
    });
    mocks.renderSystemNodeWarning.mockReturnValue("duplicate doctor runtime warning");

    await runRepair({ gateway: {} });

    const runtimeNotes = mocks.note.mock.calls.filter(([, title]) => title === "Gateway runtime");
    const runtimeMessages = runtimeNotes.map(([message]) => message);
    expect(runtimeMessages).not.toContain("duplicate doctor runtime warning");
    expect(runtimeMessages.some((message) => String(message).includes("not found"))).toBe(false);
    expect(
      runtimeMessages.some((message) =>
        String(message).includes("Using /home/orin/.nvm/versions/node/v22.22.2/bin/node"),
      ),
    ).toBe(true);
  });

  it("passes planned managed env keys into service audit for legacy inline secret detection", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        TAVILY_API_KEY: "old-inline-value",
      },
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-managed-env-embedded",
          message: "Gateway service embeds managed environment values that should load at runtime.",
          detail: "inline keys: TAVILY_API_KEY",
          level: "recommended",
        },
      ],
    });
    mocks.install.mockResolvedValue(undefined);

    await runRepair({ gateway: {} });

    expectCallField(
      mocks.auditGatewayServiceConfig,
      "expectedManagedServiceEnvKeys",
      new Set(["TAVILY_API_KEY"]),
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("repairs gateway services whose pinned port differs from current config", async () => {
    mocks.resolveGatewayPort.mockReturnValue(18888);
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {},
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/usr/local/bin/openclaw", "gateway", "--port", "18888"],
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-port-mismatch",
          message: "Gateway service port does not match current gateway config.",
          detail: "18789 -> 18888",
          level: "recommended",
        },
      ],
    });
    mocks.install.mockResolvedValue(undefined);

    await runRepair({ gateway: { port: 18888 } });

    expectCallField(mocks.auditGatewayServiceConfig, "expectedPort", 18888);
    const installOptions = requireRecord(
      callArg(mocks.install, 0, "install call"),
      "install options",
    );
    expect(installOptions.programArguments).toContain("18888");
  });

  it("repairs gateway services with embedded proxy environment values", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        HTTP_PROXY: "http://proxy.local:7890",
        HTTPS_PROXY: "https://proxy.local:7890",
      },
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-proxy-env-embedded",
          message: "Gateway service embeds proxy environment values that should not be persisted.",
          detail: "inline keys: HTTP_PROXY, HTTPS_PROXY",
          level: "recommended",
        },
      ],
    });
    mocks.install.mockResolvedValue(undefined);

    await runRepair({ gateway: {} });

    expect(mocks.install).toHaveBeenCalledOnce();
    const installOptions = mocks.install.mock.calls[0]?.[0];
    expect(installOptions?.environment).toStrictEqual({});
    expect(Object.hasOwn(installOptions?.environment ?? {}, "HTTP_PROXY")).toBe(false);
    expect(Object.hasOwn(installOptions?.environment ?? {}, "HTTPS_PROXY")).toBe(false);
  });

  it("uses OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      setupGatewayTokenRepairScenario();

      const cfg: OpenClawConfig = {
        gateway: {},
      };

      await runRepair(cfg);

      expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", "env-token");
      expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "env-token");
      const replaceOptions = requireRecord(
        callArg(mocks.replaceConfigFile, 0, "replaceConfigFile call"),
        "replaceConfigFile options",
      );
      expectGatewayAuthToken(replaceOptions.nextConfig, "env-token");
      expect(replaceOptions.afterWrite).toEqual({ mode: "auto" });
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

  it("keeps wrapper-managed gateway services aligned during entrypoint drift checks", async () => {
    const wrapperPath = "/usr/local/bin/openclaw-doppler";
    mocks.readCommand.mockResolvedValue({
      programArguments: [wrapperPath, "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_WRAPPER: wrapperPath,
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ env }) => ({
      programArguments: [env.OPENCLAW_WRAPPER, "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_WRAPPER: env.OPENCLAW_WRAPPER,
      },
    }));

    await runRepair({ gateway: {} });

    const installPlanOptions = requireRecord(
      callArg(mocks.buildGatewayInstallPlan, 0, "buildGatewayInstallPlan call"),
      "buildGatewayInstallPlan options",
    );
    expect(requireRecord(installPlanOptions.env, "install env").OPENCLAW_WRAPPER).toBe(wrapperPath);
    expect(
      requireRecord(installPlanOptions.existingEnvironment, "install existing environment")
        .OPENCLAW_WRAPPER,
    ).toBe(wrapperPath);
    expectNoNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      "Gateway service invokes OPENCLAW_WRAPPER: /usr/local/bin/openclaw-doppler",
      "Gateway",
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

  it("skips entrypoint rewrites for an active systemd unit", async () => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      ...createGatewayCommand("/opt/old-openclaw/dist/index.js"),
      sourcePath: "/etc/systemd/system/custom-gateway.service",
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      ...createGatewayCommand("/opt/new-openclaw/dist/index.js"),
      workingDirectory: "/tmp",
    });
    mocks.isSystemdUnitActive.mockResolvedValue(true);

    await runRepair({ gateway: {} });

    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "system",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("skipped command/entrypoint rewrites"),
      "Gateway service config",
    );
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("repairs entrypoint drift when the systemd unit is stopped", async () => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      ...createGatewayCommand("/opt/old-openclaw/dist/index.js"),
      sourcePath: "/home/test/.config/systemd/user/custom-gateway.service",
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      ...createGatewayCommand("/opt/new-openclaw/dist/index.js"),
      workingDirectory: "/tmp",
    });
    mocks.isSystemdUnitActive.mockResolvedValue(false);

    await runRepair({ gateway: {} });

    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "user",
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("leaves all service metadata unchanged when an active unit has command drift plus other issues", async () => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      programArguments: ["/usr/bin/openclaw", "run"],
      environment: {},
      sourcePath: "/home/test/.config/systemd/user/openclaw-gateway.service",
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-command-missing",
          message: "Service command does not include the gateway subcommand",
          level: "aggressive",
        },
        {
          code: "gateway-port-mismatch",
          message: "Gateway service port does not match current gateway config.",
          detail: "18789 -> 18888",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.isSystemdUnitActive.mockResolvedValue(true);

    await runRepair({ gateway: { port: 18888 } });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service port does not match current gateway config."),
      "Gateway service config",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("leaving supervisor metadata unchanged"),
      "Gateway service config",
    );
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("skips entrypoint rewrite in non-interactive fix mode", async () => {
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
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw gateway install --force"),
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
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

    expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", undefined);
    expectCallField(mocks.buildGatewayInstallPlan, "config", cfg);
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

        expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", undefined);
        const replaceOptions = requireRecord(
          callArg(mocks.replaceConfigFile, 0, "replaceConfigFile call"),
          "replaceConfigFile options",
        );
        expectGatewayAuthToken(replaceOptions.nextConfig, "stale-token");
        expect(replaceOptions.afterWrite).toEqual({ mode: "auto" });
        expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "stale-token");
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

        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
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

        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expectCallField(mocks.buildGatewayInstallPlan, "config", cfg);
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
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
    });
  });

  it("warns when the gateway service entrypoint resolves to a source checkout", async () => {
    await withEnvAsync({}, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-service-layout-"));
      try {
        await fs.mkdir(path.join(root, ".git"), { recursive: true });
        await fs.mkdir(path.join(root, "src"), { recursive: true });
        await fs.mkdir(path.join(root, "extensions"), { recursive: true });
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
          "utf8",
        );
        const entrypoint = path.join(root, "dist", "index.js");
        await fs.writeFile(entrypoint, "export {};\n", "utf8");
        mocks.readCommand.mockResolvedValue(createGatewayCommand(entrypoint));
        mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
        mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayCommand(entrypoint));

        await runRepair({ gateway: {} });

        expect(mocks.note).toHaveBeenCalledWith(
          expect.stringContaining("resolves to a source checkout"),
          "Gateway service config",
        );
        expect(mocks.install).not.toHaveBeenCalled();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("maybeScanExtraGatewayServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findExtraGatewayServices.mockResolvedValue([]);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    mocks.isSystemdUnitActive.mockResolvedValue(false);
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([]);
  });

  afterEach(() => {
    mockProcessPlatform(originalPlatform);
  });

  it("ignores inactive non-legacy Linux gateway-like services", async () => {
    mockProcessPlatform("linux");
    mocks.findExtraGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "custom-gateway.service",
        detail: "unit: /home/test/.config/systemd/user/custom-gateway.service",
        scope: "user",
        legacy: false,
      },
    ]);
    mocks.isSystemdUnitActive.mockResolvedValue(false);

    await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "user",
    );
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("custom-gateway.service"),
      "Other gateway-like services detected",
    );
  });

  it("reports active non-legacy Linux gateway-like services", async () => {
    mockProcessPlatform("linux");
    mocks.findExtraGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "custom-gateway.service",
        detail: "unit: /etc/systemd/system/custom-gateway.service",
        scope: "system",
        legacy: false,
      },
    ]);
    mocks.isSystemdUnitActive.mockResolvedValue(true);

    await maybeScanExtraGatewayServices({ deep: true }, makeDoctorIo(), makeDoctorPrompts());

    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "system",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("custom-gateway.service"),
      "Other gateway-like services detected",
    );
  });

  it("removes legacy Linux user systemd services", async () => {
    mockProcessPlatform("linux");
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
