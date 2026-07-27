// Doctor gateway service tests cover service audit diagnostics and duplicate gateway service reporting.
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
  readRuntime: vi.fn(),
  stage: vi.fn(),
  install: vi.fn(),
  restart: vi.fn(),
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
  readWindowsProcessArgsSync: vi.fn(),
  readWindowsStartupFallbackRuntimeForUpdate: vi.fn(),
  runExec: vi.fn(),
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
    readRuntime: mocks.readRuntime,
    stage: mocks.stage,
    install: mocks.install,
    restart: mocks.restart,
  }),
}));

vi.mock("../daemon/schtasks.js", () => ({
  readWindowsStartupFallbackRuntimeForUpdate: mocks.readWindowsStartupFallbackRuntimeForUpdate,
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUnitActive: mocks.isSystemdUnitActive,
  uninstallLegacySystemdUnits: mocks.uninstallLegacySystemdUnits,
}));

vi.mock("../infra/windows-port-pids.js", () => ({
  readWindowsProcessArgsSync: mocks.readWindowsProcessArgsSync,
}));

vi.mock("../process/exec.js", () => ({
  runExec: mocks.runExec,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

vi.mock("./doctor-gateway-auth-token.js", () => ({
  resolveGatewayAuthTokenForService: mocks.resolveGatewayAuthTokenForService,
}));

import {
  detectExtraGatewayServiceIssues,
  extraGatewayServiceToHealthFinding,
  extraGatewayServiceToRepairEffects,
  maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import { EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy.js";

const originalStdinIsTTY = process.stdin.isTTY;
const originalPlatform = process.platform;
const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
const originalParentSupportsConfigWrite =
  process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE;
const originalParentSupportsGatewayRestart =
  process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART;
const originalParentAllowsGatewayServiceRepair =
  process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR;
const originalParentAllowsGatewayActivation =
  process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION;

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

const LEGACY_MAC_LABEL = "com.openclaw.gateway";
const LEGACY_MAC_PLIST = "/Users/test/Library/LaunchAgents/com.openclaw.gateway.plist";

function setupLegacyMacService() {
  mockProcessPlatform("darwin");
  mocks.findExtraGatewayServices.mockResolvedValue([
    {
      platform: "darwin",
      label: LEGACY_MAC_LABEL,
      detail: `plist: ${LEGACY_MAC_PLIST}`,
      scope: "user",
      legacy: true,
    },
  ]);
}

function launchctlFailure(
  params: {
    message?: string;
    stderr?: string;
    stdout?: string;
    timedOut?: boolean;
  } = {},
) {
  return Object.assign(new Error(params.message ?? "launchctl failed"), {
    stderr: params.stderr ?? "",
    stdout: params.stdout ?? "",
    ...(params.timedOut ? { timedOut: true } : {}),
  });
}

function expectBoundedLaunchctlCleanup() {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  expect(mocks.runExec).toHaveBeenNthCalledWith(
    1,
    "launchctl",
    ["bootout", domain, LEGACY_MAC_PLIST],
    { logOutput: false, timeoutMs: 5_000 },
  );
  expect(mocks.runExec).toHaveBeenNthCalledWith(2, "launchctl", ["unload", LEGACY_MAC_PLIST], {
    logOutput: false,
    timeoutMs: 5_000,
  });
  expect(mocks.runExec).toHaveBeenNthCalledWith(
    3,
    "launchctl",
    ["print", `${domain}/${LEGACY_MAC_LABEL}`],
    {
      logOutput: false,
      timeoutMs: expect.any(Number),
    },
  );
  const probeTimeout = mocks.runExec.mock.calls[2]?.[2]?.timeoutMs;
  expect(probeTimeout).toBeGreaterThan(0);
  expect(probeTimeout).toBeLessThanOrEqual(5_000);
}

function mockConfirmedUnloaded(stderr = "Could not find service") {
  mocks.runExec
    .mockResolvedValueOnce({ stdout: "", stderr: "" })
    .mockResolvedValueOnce({ stdout: "", stderr: "" })
    .mockRejectedValueOnce(launchctlFailure({ stderr }));
}

async function runRepair(cfg: OpenClawConfig, options: { allowExecSecretRefs?: boolean } = {}) {
  await maybeRepairGatewayServiceConfig(cfg, "local", makeDoctorIo(), makeDoctorPrompts(), options);
}

async function runNonInteractiveRepair(params: {
  cfg?: OpenClawConfig;
  updateInProgress?: boolean;
  lastTouchedVersionOverride?: string;
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
    params.lastTouchedVersionOverride
      ? { lastTouchedVersionOverride: params.lastTouchedVersionOverride }
      : {},
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
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function callArg(mock: { mock: { calls: Array<Array<unknown>> } }, index: number, label: string) {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  return call[0];
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
  const matchingCalls = mock.mock.calls.filter(([value]) => {
    const options = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return readGatewayAuthToken(options.config) === expected;
  });
  expect(matchingCalls).not.toEqual([]);
}

function expectNoteContaining(messagePart: string, title: string) {
  const messages = mocks.note.mock.calls
    .filter(([, callTitle]) => callTitle === title)
    .map(([message]) => String(message));
  expect(messages.join("\n")).toContain(messagePart);
}

function expectNoNoteContaining(messagePart: string, title: string) {
  const messages = mocks.note.mock.calls
    .filter(([, callTitle]) => callTitle === title)
    .map(([message]) => String(message));
  expect(messages.join("\n")).not.toContain(messagePart);
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
    mocks.readRuntime.mockResolvedValue({ status: "unknown" });
    mocks.readWindowsStartupFallbackRuntimeForUpdate.mockResolvedValue(null);
    mocks.needsNodeRuntimeMigration.mockReturnValue(false);
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.isSystemdUnitActive.mockResolvedValue(false);
    mocks.readWindowsProcessArgsSync.mockReturnValue(["node", "openclaw.mjs", "update"]);
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
    if (originalParentSupportsConfigWrite === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE =
        originalParentSupportsConfigWrite;
    }
    if (originalParentSupportsGatewayRestart === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART =
        originalParentSupportsGatewayRestart;
    }
    if (originalParentAllowsGatewayServiceRepair === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR =
        originalParentAllowsGatewayServiceRepair;
    }
    if (originalParentAllowsGatewayActivation === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION =
        originalParentAllowsGatewayActivation;
    }
  });

  it("reports the installed Gateway heap limit and derivation", async () => {
    const command = createGatewayCommand("/opt/openclaw/dist/index.js");
    command.environment = { NODE_OPTIONS: "--max-old-space-size=6144" };
    mocks.readCommand.mockResolvedValue(command);
    mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
    mocks.buildGatewayInstallPlan.mockResolvedValue(command);

    await runRepair({ gateway: {} });

    expectNoteContaining("6144 MiB", "Gateway heap");
    expectNoteContaining("adaptive default", "Gateway heap");
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

  it("passes exec SecretRef policy into service token resolution", async () => {
    setupGatewayTokenRepairScenario();

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "exec",
            provider: "execmain",
            id: "gateway/token",
          },
        },
      },
      secrets: {
        providers: {
          execmain: {
            source: "exec",
            command: process.execPath,
          },
        },
      },
    };

    await runRepair(cfg, { allowExecSecretRefs: true });

    expect(mocks.resolveGatewayAuthTokenForService).toHaveBeenCalledWith(cfg, process.env, {
      allowExecSecretRefs: true,
    });
  });

  it("does not duplicate gateway runtime warnings already emitted by the node install plan", async () => {
    const nvmNode = "/home/test/.nvm/versions/node/v22.22.3/bin/node";
    mocks.readCommand.mockResolvedValue({
      programArguments: [nvmNode, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ warn }) => {
      warn?.(
        "System Node 20.20.2 at /usr/bin/node is outside the supported range. Using /home/test/.nvm/versions/node/v22.22.3/bin/node for the daemon.",
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
    expect(runtimeMessages.map((message) => String(message)).join("\n")).not.toContain("not found");
    expect(runtimeMessages.map((message) => String(message)).join("\n")).toContain(
      "Using /home/test/.nvm/versions/node/v22.22.3/bin/node",
    );
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
    const installOptions = requireRecord(callArg(mocks.install, 0, "gateway install"), "install");
    const environment = requireRecord(installOptions.environment, "install environment");
    expect(environment).toStrictEqual({});
    expect(Object.hasOwn(environment, "HTTP_PROXY")).toBe(false);
    expect(Object.hasOwn(environment, "HTTPS_PROXY")).toBe(false);
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
        const normalized = value.replaceAll("\\", "/").replace(/^[A-Z]:/i, "");
        if (normalized.includes("/global/5/node_modules/openclaw/")) {
          return normalized.replace(
            "/global/5/node_modules/openclaw/",
            "/global/5/node_modules/.pnpm/openclaw@2026.3.12/node_modules/openclaw/",
          );
        }
        return normalized;
      },
    });

    await runRepair({ gateway: {} });

    expectNoNoteContaining(
      "Gateway service entrypoint does not match the current install.",
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

    expectNoNoteContaining(
      "Gateway service entrypoint does not match the current install.",
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

    expectNoteContaining(
      "Gateway service entrypoint does not match the current install.",
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
    expectNoteContaining("skipped command/entrypoint rewrites", "Gateway service config");
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

    expectNoteContaining(
      "Gateway service port does not match current gateway config.",
      "Gateway service config",
    );
    expectNoteContaining("leaving supervisor metadata unchanged", "Gateway service config");
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

    expectNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expectNoteContaining("openclaw gateway install --force", "Gateway service config");
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("defers systemd service config rewrites during non-interactive update repairs", async () => {
    mockProcessPlatform("linux");
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      installWorkingDirectory: "/tmp",
    });

    await runNonInteractiveRepair({
      cfg: { gateway: {} },
      updateInProgress: true,
    });

    expectNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expectNoteContaining("left the live systemd unit unchanged", "Gateway service config");
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("keeps staging non-systemd service config repairs during non-interactive update repairs", async () => {
    mockProcessPlatform("darwin");
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      installWorkingDirectory: "/tmp",
    });

    await runNonInteractiveRepair({
      cfg: { gateway: {} },
      updateInProgress: true,
    });

    expectNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expectNoNoteContaining("left the live systemd unit unchanged", "Gateway service config");
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

  it("does not persist or stage embedded service tokens during systemd update repairs", async () => {
    mockProcessPlatform("linux");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";

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
        expectNoteContaining("left the live systemd unit unchanged", "Gateway service config");
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    ["update command", ["node", "openclaw.mjs", "update"]],
    ["--update shorthand", ["node", "openclaw.mjs", "--update"]],
    ["doctor update prompt", ["node", "openclaw.mjs", "doctor"]],
  ])("does not rewrite a service for a legacy %s parent", async (_, args) => {
    mockProcessPlatform("win32");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    mocks.readWindowsProcessArgsSync.mockReturnValue(args);
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_SERVICE_VERSION: "2026.5.25",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway Work",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-service-version-mismatch",
          message: "Gateway service was installed by an older OpenClaw version.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_SERVICE_VERSION: "2026.5.26",
      },
    });
    mocks.readRuntime.mockResolvedValue({ status: "running" });

    await runNonInteractiveRepair({ updateInProgress: true });

    expectNoteContaining(
      "Gateway service was installed by an older OpenClaw version.",
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.readRuntime).not.toHaveBeenCalled();
  });

  it("stages running Windows repairs when the update parent forbids activation", async () => {
    mockProcessPlatform("win32");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION = "0";
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_SERVICE_VERSION: "2026.5.25",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-service-version-mismatch",
          message: "Gateway service was installed by an older OpenClaw version.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_SERVICE_VERSION: "2026.5.26",
      },
    });
    mocks.readRuntime.mockResolvedValue({ status: "running" });

    await runNonInteractiveRepair({ updateInProgress: true });

    expect(mocks.readRuntime).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite a service when the update parent rejects ownership", async () => {
    mockProcessPlatform("win32");
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "0";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION = "0";
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-token",
        OPENCLAW_SERVICE_VERSION: "2026.5.25",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-service-version-mismatch",
          message: "Gateway service was installed by an older OpenClaw version.",
          level: "recommended",
        },
      ],
    });

    await runNonInteractiveRepair({ updateInProgress: true });

    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expectNoteContaining(
      "Update parent did not authorize changes to this gateway service definition",
      "Gateway service config",
    );
  });

  it.each([
    {
      parent: "direct --no-restart update",
      args: ["node", "openclaw.mjs", "update", "--no-restart"],
    },
    {
      parent: "--update shorthand with --no-restart",
      args: ["node", "openclaw.mjs", "--update", "--no-restart"],
    },
    {
      parent: "interactive update wizard",
      args: ["node", "openclaw.mjs", "update", "wizard"],
    },
    {
      parent: "unrecognized shell",
      args: ["powershell.exe"],
    },
    {
      parent: "gateway RPC process",
      args: ["node", "openclaw.mjs", "gateway"],
    },
  ])("stages repairs for a $parent parent without an activation marker", async ({ args }) => {
    mockProcessPlatform("win32");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";
    mocks.readWindowsProcessArgsSync.mockReturnValue(args);
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: { OPENCLAW_SERVICE_VERSION: "2026.5.25" },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-service-version-mismatch",
          message: "Gateway service was installed by an older OpenClaw version.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: { OPENCLAW_SERVICE_VERSION: "2026.5.26" },
    });
    mocks.readRuntime.mockResolvedValue({ status: "running" });

    await runNonInteractiveRepair({ updateInProgress: true });

    expect(mocks.readWindowsProcessArgsSync).toHaveBeenCalledWith(process.ppid, 1_500);
    expect(mocks.readRuntime).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it("persists embedded service tokens before Windows update repairs rewrite the task", async () => {
    mockProcessPlatform("win32");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE = "1";
    process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION = "1";

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mocks.readCommand.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "stale-token",
            OPENCLAW_SERVICE_VERSION: "2026.5.25",
          },
        });
        mocks.auditGatewayServiceConfig.mockResolvedValue({
          ok: false,
          issues: [
            {
              code: "gateway-token-embedded",
              message: "Gateway service contains an embedded token.",
              level: "recommended",
            },
          ],
        });
        mocks.buildGatewayInstallPlan.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_SERVICE_VERSION: "2026.5.26",
          },
        });
        mocks.readRuntime.mockResolvedValue({ status: "running" });
        mocks.readWindowsStartupFallbackRuntimeForUpdate.mockResolvedValue({
          status: "running",
          pid: 4242,
        });

        await runNonInteractiveRepair({
          updateInProgress: true,
          lastTouchedVersionOverride: "2026.5.14",
        });

        expect(mocks.readRuntime.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.replaceConfigFile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
        );
        const replaceOptions = requireRecord(
          callArg(mocks.replaceConfigFile, 0, "replaceConfigFile call"),
          "replaceConfigFile options",
        );
        expectGatewayAuthToken(replaceOptions.nextConfig, "stale-token");
        expect(replaceOptions.afterWrite).toEqual({ mode: "auto" });
        expect(replaceOptions.writeOptions).toEqual(
          expect.objectContaining({
            allowConfigSizeDrop: true,
            skipPluginValidation: true,
            lastTouchedVersionOverride: "2026.5.14",
          }),
        );
        expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "stale-token");
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).toHaveBeenCalledTimes(1);
        expect(mocks.install).toHaveBeenCalledWith(
          expect.objectContaining({
            startupFallbackTakeoverRuntime: { status: "running", pid: 4242 },
          }),
        );
        expect(mocks.restart).not.toHaveBeenCalled();
      },
    );
  });

  it("does not use Scheduled Task runtime as Startup-fallback takeover evidence", async () => {
    mockProcessPlatform("win32");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION = "1";
    setupGatewayTokenRepairScenario();
    mocks.readRuntime.mockResolvedValue({ status: "running" });
    mocks.readWindowsStartupFallbackRuntimeForUpdate.mockResolvedValue(null);

    await runNonInteractiveRepair({ updateInProgress: true });

    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ startupFallbackTakeoverRuntime: undefined }),
    );
  });

  it("leaves embedded service tokens untouched during legacy Windows update handoffs", async () => {
    mockProcessPlatform("win32");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    delete process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE;

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mocks.readCommand.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "stale-token",
            OPENCLAW_SERVICE_VERSION: "2026.5.25",
          },
        });
        mocks.auditGatewayServiceConfig.mockResolvedValue({
          ok: false,
          issues: [
            {
              code: "gateway-token-embedded",
              message: "Gateway service contains an embedded token.",
              level: "recommended",
            },
          ],
        });
        mocks.buildGatewayInstallPlan.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_SERVICE_VERSION: "2026.5.26",
          },
        });
        mocks.readRuntime.mockResolvedValue({ status: "running" });

        await runNonInteractiveRepair({ updateInProgress: true });

        expectNoteContaining(
          "Update parent did not authorize changes to this gateway service definition",
          "Gateway service config",
        );
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).not.toHaveBeenCalled();
      },
    );
  });

  it("stages stopped Windows update repairs without activating the gateway", async () => {
    mockProcessPlatform("win32");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR = "1";
    process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION = "1";
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_SERVICE_VERSION: "2026.5.25",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-service-version-mismatch",
          message: "Gateway service was installed by an older OpenClaw version.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_SERVICE_VERSION: "2026.5.26",
      },
    });
    mocks.readRuntime.mockResolvedValue({ status: "stopped" });

    await runNonInteractiveRepair({ updateInProgress: true });

    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
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
      expectNoteContaining(
        "Gateway service entrypoint does not match the current install.",
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

        expectNoteContaining("resolves to a source checkout", "Gateway service config");
        expect(mocks.install).not.toHaveBeenCalled();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("does not duplicate Gateway service config panels for a source-checkout entrypoint with audit findings", async () => {
    await withEnvAsync({}, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-doctor-service-config-dedup-"),
      );
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
        const sourceCheckoutEntrypoint = path.join(root, "dist", "index.js");
        await fs.writeFile(sourceCheckoutEntrypoint, "export {};\n", "utf8");
        const installEntrypoint = "/usr/local/lib/node_modules/openclaw/dist/index.js";
        setupGatewayEntrypointRepairScenario({
          currentEntrypoint: sourceCheckoutEntrypoint,
          installEntrypoint,
          installWorkingDirectory: "/tmp",
        });

        await runRepair({ gateway: {} });

        const gatewayServiceConfigNotes = mocks.note.mock.calls.filter(
          ([, title]) => title === "Gateway service config",
        );
        expect(gatewayServiceConfigNotes).toHaveLength(1);
        const consolidated = gatewayServiceConfigNotes[0]?.[0] ?? "";
        expect(consolidated).toContain(
          "Gateway service entrypoint does not match the current install.",
        );
        expect(consolidated).not.toContain("resolves to a source checkout");
        const forceMatches = consolidated.match(/openclaw gateway install --force/g) ?? [];
        expect(forceMatches).toHaveLength(0);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("keeps the gateway install force hint when a source-checkout warning is suppressed and repair is declined", async () => {
    await withEnvAsync({}, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-doctor-service-config-force-hint-"),
      );
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
        const sourceCheckoutEntrypoint = path.join(root, "dist", "index.js");
        await fs.writeFile(sourceCheckoutEntrypoint, "export {};\n", "utf8");
        const installEntrypoint = "/usr/local/lib/node_modules/openclaw/dist/index.js";
        setupGatewayEntrypointRepairScenario({
          currentEntrypoint: sourceCheckoutEntrypoint,
          installEntrypoint,
          installWorkingDirectory: "/tmp",
        });

        const declinePrompts = {
          ...makeDoctorPrompts(),
          confirmAutoFix: vi.fn().mockResolvedValue(false),
          confirmAggressiveAutoFix: vi.fn().mockResolvedValue(false),
          confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
        };
        await maybeRepairGatewayServiceConfig(
          { gateway: {} },
          "local",
          makeDoctorIo(),
          declinePrompts,
        );

        const gatewayServiceConfigNotes = mocks.note.mock.calls.filter(
          ([, title]) => title === "Gateway service config",
        );
        expect(gatewayServiceConfigNotes).toHaveLength(2);
        const auditNote = gatewayServiceConfigNotes[0]?.[0] ?? "";
        expect(auditNote).toContain(
          "Gateway service entrypoint does not match the current install.",
        );
        expect(auditNote).not.toContain("resolves to a source checkout");
        expect(gatewayServiceConfigNotes[1]?.[0]).toContain("openclaw gateway install --force");
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
    mocks.runExec.mockResolvedValue({ stdout: "", stderr: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expectNoNoteContaining("custom-gateway.service", "Other gateway-like services detected");
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
    expectNoteContaining("custom-gateway.service", "Other gateway-like services detected");
  });

  it("threads deep scans through structured extra gateway service detection", async () => {
    mocks.findExtraGatewayServices.mockResolvedValue([]);

    await detectExtraGatewayServiceIssues({ deep: true });

    expect(mocks.findExtraGatewayServices).toHaveBeenCalledWith(process.env, { deep: true });
  });

  it("maps intentional extra gateway services to informational structured findings", () => {
    expect(
      extraGatewayServiceToHealthFinding({
        platform: "linux",
        label: "custom-gateway.service",
        detail: "unit: /etc/systemd/system/custom-gateway.service",
        scope: "system",
        legacy: false,
      }),
    ).toEqual(
      expect.objectContaining({
        checkId: "core/doctor/gateway-services/extra",
        severity: "info",
        source: "linux",
        target: "custom-gateway.service",
      }),
    );
  });

  it("keeps legacy gateway services warning-level", () => {
    expect(
      extraGatewayServiceToHealthFinding({
        platform: "linux",
        label: "openclaw-gateway.service",
        detail: "legacy unit",
        scope: "user",
        legacy: true,
      }),
    ).toEqual(
      expect.objectContaining({
        checkId: "core/doctor/gateway-services/extra",
        severity: "warning",
        source: "linux",
        target: "openclaw-gateway.service",
      }),
    );
  });

  it("maps legacy gateway services to dry-run cleanup effects", () => {
    expect(
      extraGatewayServiceToRepairEffects({
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: "unit: /home/test/.config/systemd/user/clawdbot-gateway.service",
        scope: "user",
        legacy: true,
      }),
    ).toEqual([
      {
        kind: "service",
        action: "would-remove-legacy-gateway-service",
        target: "clawdbot-gateway.service",
        dryRunSafe: false,
      },
    ]);
  });

  it("does not report cleanup effects for intentional extra gateway services", () => {
    expect(
      extraGatewayServiceToRepairEffects({
        platform: "linux",
        label: "custom-gateway.service",
        detail: "unit: /etc/systemd/system/custom-gateway.service",
        scope: "system",
        legacy: false,
      }),
    ).toEqual([]);
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
    expectNoteContaining("clawdbot-gateway.service", "Legacy gateway removed");
    expect(runtime.log).toHaveBeenCalledWith(
      "Legacy gateway services removed. Installing OpenClaw gateway next.",
    );
  });

  it.each(["Could not find service", "No such process"])(
    "moves a legacy macOS plist only after print reports '%s'",
    async (stderr) => {
      setupLegacyMacService();
      mockConfirmedUnloaded(stderr);
      const runtime = makeDoctorIo();
      const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
      vi.spyOn(fs, "access").mockResolvedValue(undefined);

      await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());

      expectBoundedLaunchctlCleanup();
      expect(rename).toHaveBeenCalledTimes(1);
      expectNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
      expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway cleanup skipped");
      expect(runtime.log).toHaveBeenCalledWith(
        "Legacy gateway services removed. Installing OpenClaw gateway next.",
      );
    },
  );

  it.each([
    ["timeouts", launchctlFailure({ timedOut: true })],
    ["unknown failures", launchctlFailure({ stderr: "Permission denied" })],
  ])("keeps the plist when both launchctl calls end in %s", async (_, failure) => {
    setupLegacyMacService();
    mocks.runExec.mockRejectedValue(failure);
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const access = vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    const runtime = makeDoctorIo();

    await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());

    expectBoundedLaunchctlCleanup();
    expect(mkdir).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (launchctl could not confirm unload)`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
    expect(runtime.log).not.toHaveBeenCalledWith(
      "Legacy gateway services removed. Installing OpenClaw gateway next.",
    );
  });

  it("keeps the plist when a successful cleanup command is followed by a loaded probe", async () => {
    setupLegacyMacService();
    mocks.runExec
      .mockRejectedValueOnce(launchctlFailure({ timedOut: true }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "state = waiting\npid = 0\n", stderr: "" })
      .mockRejectedValueOnce(launchctlFailure({ stderr: "Permission denied" }));
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const access = vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    const runtime = makeDoctorIo();

    await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());

    expect(mocks.runExec).toHaveBeenCalledTimes(4);
    expect(mkdir).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (launchctl could not confirm unload)`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
  });

  it("keeps the plist when the postcondition probe times out", async () => {
    setupLegacyMacService();
    mocks.runExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(
        launchctlFailure({
          message: "Command timed out after 5000 milliseconds",
          stderr: "Could not find service",
        }),
      );
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const access = vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    const runtime = makeDoctorIo();

    await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());

    expectBoundedLaunchctlCleanup();
    expect(mkdir).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (launchctl could not confirm unload)`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
  });

  it("polls a still-registered stopped label until launchd reports it gone", async () => {
    setupLegacyMacService();
    mocks.runExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "state = waiting\npid = 0\n", stderr: "" })
      .mockRejectedValueOnce(launchctlFailure({ stderr: "Could not find service" }));
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);

    await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

    expect(mocks.runExec).toHaveBeenCalledTimes(4);
    expect(rename).toHaveBeenCalledTimes(1);
    expectNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
  });

  it("reports removal when launchctl confirms unload and the plist is already absent", async () => {
    setupLegacyMacService();
    mockConfirmedUnloaded();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "access").mockRejectedValue(missing);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);

    await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

    expectBoundedLaunchctlCleanup();
    expect(rename).not.toHaveBeenCalled();
    expectNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway cleanup skipped");
  });

  it("does not report removal when the plist cannot be inspected", async () => {
    setupLegacyMacService();
    mockConfirmedUnloaded();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "access").mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);

    await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

    expectBoundedLaunchctlCleanup();
    expect(rename).not.toHaveBeenCalled();
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (could not inspect plist)`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
  });

  it("does not report removal when the confirmed-unloaded plist cannot be moved", async () => {
    setupLegacyMacService();
    mockConfirmedUnloaded();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("permission denied"));
    const runtime = makeDoctorIo();

    await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());

    expectBoundedLaunchctlCleanup();
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (could not move plist)`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
    expect(runtime.log).not.toHaveBeenCalledWith(
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

      expectNoteContaining("clawdbot-gateway.service", "Other gateway-like services detected");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
