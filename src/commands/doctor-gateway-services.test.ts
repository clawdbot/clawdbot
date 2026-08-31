import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
// Doctor gateway service tests cover service audit diagnostics and duplicate gateway service reporting.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { LaunchctlResult } from "../daemon/launchd-exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
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
  isDefaultInstallIdentity: vi.fn(() => true),
  isContainerEnvironment: vi.fn(() => false),
  findExtraGatewayServices: vi.fn().mockResolvedValue([]),
  renderGatewayServiceCleanupHints: vi.fn().mockReturnValue([]),
  needsNodeRuntimeMigration: vi.fn(() => false),
  renderSystemNodeWarning: vi.fn().mockReturnValue(undefined),
  resolveSystemNodeInfo: vi.fn().mockResolvedValue(null),
  isSystemdUnitActive: vi
    .fn<typeof import("../daemon/systemd-exec.js").isSystemdUnitActive>()
    .mockResolvedValue({ ok: true, value: false }),
  uninstallLegacySystemdUnits: vi.fn().mockResolvedValue([]),
  readWindowsProcessArgsSync: vi.fn(),
  readWindowsStartupFallbackRuntimeForUpdate: vi.fn(),
  execLaunchctl: vi.fn(),
  findSystemdGatewayInstallation: vi.fn().mockResolvedValue({ kind: "none" }),
  isSystemUnitActiveAndEnabled: vi.fn().mockResolvedValue(false),
  uninstallUserSystemdGatewayUnit: vi.fn().mockResolvedValue({
    unitName: "openclaw-gateway.service",
    unitPath: "",
    removed: true,
    disabled: true,
  }),
  note: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  isDefaultInstallIdentity: mocks.isDefaultInstallIdentity,
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
    gatewayPathMissing: "gateway-path-missing",
    gatewayPathMissingDirs: "gateway-path-missing-dirs",
    gatewayPathNonMinimal: "gateway-path-nonminimal",
    gatewayPortMismatch: testServiceAuditCodes.gatewayPortMismatch,
    gatewayProxyEnvEmbedded: testServiceAuditCodes.gatewayProxyEnvEmbedded,
    gatewayRuntimeProbeFailed: "gateway-runtime-probe-failed",
    gatewayTokenDrift: "gateway-token-drift",
    gatewayTokenEmbedded: "gateway-token-embedded",
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
  findSystemdGatewayInstallation: mocks.findSystemdGatewayInstallation,
  isSystemUnitActiveAndEnabled: mocks.isSystemUnitActiveAndEnabled,
  uninstallUserSystemdGatewayUnit: mocks.uninstallUserSystemdGatewayUnit,
}));

vi.mock("../infra/windows-port-pids.js", () => ({
  readWindowsProcessArgsSync: mocks.readWindowsProcessArgsSync,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd-exec.js")>()),
  execLaunchctl: mocks.execLaunchctl,
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
  maybeResolveDuelingSystemdGatewayScopes,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import { EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy.js";

const originalStdinIsTTY = process.stdin.isTTY;
const originalPlatform = process.platform;
const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
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

function launchctlResult(params: Partial<LaunchctlResult> = {}): LaunchctlResult {
  return { stdout: "", stderr: "", code: 0, termination: "exit", ...params };
}

function expectBoundedLaunchctlCleanup() {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  expect(mocks.execLaunchctl).toHaveBeenNthCalledWith(
    1,
    ["bootout", domain, LEGACY_MAC_PLIST],
    5_000,
  );
  expect(mocks.execLaunchctl).toHaveBeenNthCalledWith(2, ["unload", LEGACY_MAC_PLIST], 5_000);
  expect(mocks.execLaunchctl).toHaveBeenNthCalledWith(
    3,
    ["print", `${domain}/${LEGACY_MAC_LABEL}`],
    expect.any(Number),
  );
  const probeTimeout = mocks.execLaunchctl.mock.calls[2]?.[1];
  expect(probeTimeout).toBeGreaterThan(0);
  expect(probeTimeout).toBeLessThanOrEqual(5_000);
}

function mockConfirmedUnloaded(stderr = "Could not find service") {
  mocks.execLaunchctl
    .mockResolvedValueOnce(launchctlResult())
    .mockResolvedValueOnce(launchctlResult())
    .mockResolvedValueOnce(launchctlResult({ code: 113, stderr }));
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

const requireRecord = createRequireRecord("object", "expected-label");

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
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    fsMocks.realpath.mockImplementation(async (value: string) => value);
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.isDefaultInstallIdentity.mockReturnValue(true);
    mocks.readRuntime.mockResolvedValue({ status: "unknown" });
    mocks.readWindowsStartupFallbackRuntimeForUpdate.mockResolvedValue(null);
    mocks.needsNodeRuntimeMigration.mockReturnValue(false);
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.isSystemdUnitActive.mockResolvedValue(ok(false));
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
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
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

  it.each(["NODE_OPTIONS", "argv"])(
    "reports configured Gateway heap controls from %s separately from runtime measurements",
    async (source) => {
      const command = createGatewayCommand("/opt/openclaw/dist/index.js");
      if (source === "NODE_OPTIONS") {
        command.environment = { NODE_OPTIONS: "--max-old-space-size=6144" };
      } else {
        command.programArguments.splice(1, 0, "--max-old-space-size=6144");
      }
      mocks.readCommand.mockResolvedValue(command);
      mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
      mocks.buildGatewayInstallPlan.mockResolvedValue(command);

      await runRepair({ gateway: {} });

      expectNoteContaining(`service ${source}: --max-old-space-size=6144`, "Gateway heap");
      expectNoteContaining("installer recommendation:", "Gateway heap");
      expectNoteContaining("runtime V8 ceiling: not measured", "Gateway heap");
    },
  );

  it("skips service audit and rewrite for a non-default install identity", async () => {
    mocks.isDefaultInstallIdentity.mockReturnValue(false);

    await runRepair({ gateway: {} });

    expect(mocks.readCommand).not.toHaveBeenCalled();
    expect(mocks.auditGatewayServiceConfig).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expectNoteContaining(
      "service management skipped: non-default state dir or config path",
      "Gateway",
    );
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
      status: "unsupported",
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

  it.each([false, true])(
    "reports failed Bun probes without runtime migration (other repairable drift: %s)",
    async (otherDrift) => {
      const bunCommand = {
        programArguments: ["/opt/bun", "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
        environment: {},
      };
      mocks.readCommand.mockResolvedValue(bunCommand);
      mocks.buildGatewayInstallPlan.mockResolvedValue(bunCommand);
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: false,
        issues: [
          {
            code: "gateway-runtime-probe-failed",
            message: "Gateway service Bun runtime probe failed.",
            detail: "/opt/bun (cwd /root): EACCES",
          },
          ...(otherDrift
            ? [{ code: "gateway-path-nonminimal", message: "Gateway PATH should be regenerated" }]
            : []),
        ],
      });
      const prompter = makeDoctorPrompts();

      await maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter);

      expectNoteContaining("/opt/bun (cwd /root): EACCES", "Gateway service config");
      expectNoNoteContaining("unsupported", "Gateway service config");
      expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
      expect(prompter.confirmRuntimeRepair).toHaveBeenCalledTimes(Number(otherDrift));
      expect(mocks.install).toHaveBeenCalledTimes(Number(otherDrift));
      for (const [options] of mocks.buildGatewayInstallPlan.mock.calls) {
        expect(options).toEqual(
          expect.objectContaining({ runtime: "bun", runtimePath: "/opt/bun" }),
        );
      }
    },
  );

  it("preserves a supported Bun runtime when repairing the Gateway service", async () => {
    const bunPath = "/home/test/.bun/bin/bun";
    const bunCommand = {
      programArguments: [bunPath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    };
    mocks.readCommand.mockResolvedValue(bunCommand);
    mocks.buildGatewayInstallPlan.mockResolvedValue(bunCommand);
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-path-nonminimal",
          message: "Gateway PATH should be regenerated",
          level: "recommended",
        },
      ],
    });

    await runRepair({ gateway: {} });

    for (const [options] of mocks.buildGatewayInstallPlan.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ runtime: "bun", runtimePath: bunPath }));
    }
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ programArguments: bunCommand.programArguments }),
    );
  });

  it("migrates an unsupported Bun Gateway service to supported system Node", async () => {
    const bunPath = "/home/test/.bun/bin/bun";
    const systemNodePath = "/usr/bin/node";
    mocks.readCommand.mockResolvedValue({
      programArguments: [bunPath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ runtimePath }) => ({
      programArguments: [runtimePath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    }));
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-runtime-bun",
          message: "Bun runtime is unsupported",
          level: "recommended",
        },
      ],
    });
    mocks.needsNodeRuntimeMigration.mockReturnValue(true);
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: systemNodePath,
      version: "24.15.0",
      status: "supported",
    });

    await runRepair({ gateway: {} });

    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "node", runtimePath: systemNodePath }),
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({
        programArguments: [systemNodePath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      }),
    );
  });

  it("passes planned managed env keys into service audit for legacy inline secret detection", async () => {
    mockProcessPlatform("linux");
    const managedDefinition = {
      programArguments: [
        "/usr/bin/node",
        "--max-old-space-size=24576",
        "--require=/tmp/service-preload.js",
        ...gatewayProgramArguments.slice(1),
      ],
      environment: { OPENCLAW_WRAPPER: "/managed-wrapper", TAVILY_API_KEY: "managed" },
      environmentValueSources: { TAVILY_API_KEY: "file" as const },
    };
    const existingCommand = {
      ...managedDefinition,
      environment: {
        OPENCLAW_WRAPPER: "/operator-wrapper",
        TAVILY_API_KEY: "old-inline-value",
        NODE_OPTIONS: "--max-old-space-size=512",
      },
      managedDefinition,
      managedOverrides: { environment: { keys: ["OPENCLAW_WRAPPER", "NODE_OPTIONS"] } },
    };
    mocks.readCommand.mockResolvedValue(existingCommand);
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
          environmentKeys: ["TAVILY_API_KEY"],
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
    for (const [plan] of mocks.buildGatewayInstallPlan.mock.calls) {
      expect(plan).toEqual(
        expect.objectContaining({
          existingCommand,
          existingEnvironment: managedDefinition.environment,
          existingEnvironmentValueSources: managedDefinition.environmentValueSources,
        }),
      );
    }
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("repairs managed port drift even when an operator overrides the working directory", async () => {
    mockProcessPlatform("linux");
    mocks.resolveGatewayPort.mockReturnValue(18888);
    const managedDefinition = {
      programArguments: gatewayProgramArguments,
      workingDirectory: "/opt/managed-openclaw",
      environment: {},
    };
    mocks.readCommand.mockResolvedValue({
      ...managedDefinition,
      workingDirectory: "/opt/operator-openclaw",
      managedDefinition,
      managedOverrides: { launcher: "working-directory" },
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
    expectNoNoteContaining("operator-owned systemd drop-in", "Gateway service config");
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
          environmentKeys: ["HTTP_PROXY", "HTTPS_PROXY"],
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

  it.each([
    [
      "relative entrypoint",
      "dist/index.js",
      "/opt/openclaw",
      { launcher: "working-directory" },
      undefined,
    ],
    [
      "harmless environment with a managed token issue",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { keys: ["NODE_COMPILE_CACHE"] } },
      "gateway-token-mismatch",
    ],
    [
      "an operator-owned managed key with a different embedded managed key",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { keys: ["MANAGED_A"] } },
      "gateway-managed-env-embedded",
    ],
    [
      "a file reset with an inline token issue",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { resetFiles: true } },
      "gateway-token-mismatch",
    ],
    [
      "a file reset with an inline PATH issue",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { resetFiles: true } },
      "gateway-path-missing",
    ],
    [
      "a reset-only proxy removal",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { resetInline: true } },
      "gateway-proxy-env-embedded",
    ],
  ] as const)(
    "does not attribute unrelated repair issues to %s",
    async (_, entrypoint, directory, overrides, issue) => {
      mockProcessPlatform("linux");
      const embeddedManagedIssue = issue === "gateway-managed-env-embedded";
      const managedDefinition = {
        ...createGatewayCommand(entrypoint),
        environment: embeddedManagedIssue
          ? { MANAGED_B: "embedded-base-value" }
          : issue === "gateway-proxy-env-embedded"
            ? { HTTPS_PROXY: "http://proxy.local" }
            : issue === "gateway-path-missing"
              ? { PATH: "/managed/bin" }
              : issue
                ? { OPENCLAW_GATEWAY_TOKEN: "stale-token" }
                : {},
      };
      mocks.readCommand.mockResolvedValue({
        ...managedDefinition,
        workingDirectory: directory,
        environment:
          "environment" in overrides && "keys" in overrides.environment
            ? {
                ...managedDefinition.environment,
                [overrides.environment.keys[0]]: "operator-owned",
              }
            : managedDefinition.environment,
        managedDefinition,
        managedOverrides: overrides,
      });
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: !issue,
        issues: issue
          ? [
              {
                code: issue,
                message: "repair",
                level: "recommended",
                environmentKeys: embeddedManagedIssue
                  ? ["MANAGED_B"]
                  : issue === "gateway-proxy-env-embedded"
                    ? ["HTTPS_PROXY"]
                    : undefined,
              },
            ]
          : [],
      });
      mocks.buildGatewayInstallPlan.mockResolvedValue({
        ...createGatewayCommand(directory ? path.join(directory, entrypoint) : entrypoint),
        ...(embeddedManagedIssue
          ? { environment: { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "MANAGED_A,MANAGED_B" } }
          : {}),
        environmentValueSources: {
          PATH: "inline",
          OPENCLAW_GATEWAY_TOKEN: "inline",
        },
      });

      await runRepair({ gateway: { auth: { token: "configured-token" } } });

      expectNoNoteContaining("operator-owned systemd drop-in", "Gateway service config");
      expect(mocks.install).toHaveBeenCalledTimes(issue ? 1 : 0);
    },
  );

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
      managedDefinition: createGatewayCommand("/opt/new-openclaw/dist/index.js"),
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      ...createGatewayCommand("/opt/new-openclaw/dist/index.js"),
      workingDirectory: "/tmp",
    });
    mocks.isSystemdUnitActive.mockResolvedValue(ok(true));

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

  it.each([
    ["command", { launcher: "command" as const }, "gateway-port-mismatch"],
    ["directory", { launcher: "working-directory" as const }, "gateway-entrypoint-mismatch"],
    ["environment", { environment: { keys: ["tavily_api_key"] } }, "gateway-managed-env-embedded"],
    ["lowercase proxy", { environment: { keys: ["https_proxy"] } }, "gateway-proxy-env-embedded"],
    ["file-backed token reset", { environment: { resetFiles: true } }, "gateway-token-mismatch"],
    [
      "file-backed managed reset",
      { environment: { resetFiles: true } },
      "gateway-managed-env-embedded",
    ],
    ["future inline PATH reset", { environment: { resetInline: true } }, "gateway-path-missing"],
  ])(
    "does not rewrite a stopped service controlled by a %s drop-in",
    async (_, overrides, issue) => {
      mockProcessPlatform("linux");
      const fileReset = "environment" in overrides && "resetFiles" in overrides.environment;
      const managedDefinition = {
        ...createGatewayCommand("/usr/local/bin/openclaw"),
        environment: { TAVILY_API_KEY: "same-value", https_proxy: "http://proxy.local" },
      };
      mocks.readCommand.mockResolvedValue({
        ...managedDefinition,
        sourcePath: "/home/test/.config/systemd/user/custom-gateway.service",
        managedDefinition,
        managedOverrides: overrides,
      });
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: false,
        issues: [
          {
            code: issue,
            message: "repair",
            level: "recommended",
            environmentKeys:
              issue === "gateway-proxy-env-embedded" ? ["https_proxy"] : ["TAVILY_API_KEY"],
          },
        ],
      });
      mocks.buildGatewayInstallPlan.mockResolvedValue({
        ...managedDefinition,
        environment: {
          PATH: "/usr/bin",
          OPENCLAW_GATEWAY_TOKEN: "future-managed-token",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
        },
        environmentValueSources: {
          PATH: "inline",
          OPENCLAW_GATEWAY_TOKEN: fileReset ? "file" : "inline",
          tavily_api_key: fileReset ? "file" : "inline",
        },
      });

      await runRepair({ gateway: {} });

      expectNoteContaining("operator-owned systemd drop-in", "Gateway service config");
      expectNoteContaining("systemctl --user cat custom-gateway.service", "Gateway service config");
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );

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
    mocks.isSystemdUnitActive.mockResolvedValue(ok(false));

    await runRepair({ gateway: {} });

    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "user",
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it.each([
    ["active", ok(true)],
    ["bus query failed", err("Failed to connect to bus: Permission denied")],
    ["timed out", err("Command timed out")],
  ] satisfies [string, Result<boolean, string>][])(
    "leaves service metadata unchanged when unit activity is %s and command drift accompanies other issues",
    async (_, active) => {
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
      mocks.isSystemdUnitActive.mockResolvedValue(active);

      await runRepair({ gateway: { port: 18888 } });

      expectNoteContaining(
        "Gateway service port does not match current gateway config.",
        "Gateway service config",
      );
      expectNoteContaining("supervisor metadata unchanged", "Gateway service config");
      if (active.ok) {
        expectNoteContaining(
          "is running; skipped command/entrypoint rewrites",
          "Gateway service config",
        );
        expectNoNoteContaining("Service command does not include", "Gateway service config");
      } else {
        expectNoteContaining("Service command does not include", "Gateway service config");
        expectNoteContaining(active.error, "Gateway service config");
        expectNoteContaining(
          "systemctl --user status openclaw-gateway.service",
          "Gateway service config",
        );
        expectNoNoteContaining("is running;", "Gateway service config");
      }
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );

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
    mockProcessPlatform("linux");
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        setupGatewayTokenRepairScenario();
        mocks.readCommand.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: { OPENCLAW_GATEWAY_TOKEN: "stale-token" },
        });

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
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway Work",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-entrypoint-mismatch",
          message: "Gateway service entrypoint differs from the current install.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.readRuntime.mockResolvedValue({ status: "running" });

    await runNonInteractiveRepair({ updateInProgress: true });

    expectNoteContaining(
      "Gateway service entrypoint differs from the current install.",
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
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-entrypoint-mismatch",
          message: "Gateway service entrypoint differs from the current install.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
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
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-entrypoint-mismatch",
          message: "Gateway service entrypoint differs from the current install.",
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
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-entrypoint-mismatch",
          message: "Gateway service entrypoint differs from the current install.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
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
          environment: {},
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
          environment: {},
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
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-entrypoint-mismatch",
          message: "Gateway service entrypoint differs from the current install.",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
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

  it.each(["OPENCLAW_SERVICE_REPAIR_POLICY", "OPENCLAW_SUPERVISOR_MODE"])(
    "reports service config drift but skips repair when %s is external",
    async (envKey) => {
      await withEnvAsync({ [envKey]: "external" }, async () => {
        setupGatewayEntrypointRepairScenario({
          currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
          installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
          installWorkingDirectory: "/tmp",
        });
        const prompter = makeDoctorPrompts();

        await maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter);

        expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledOnce();
        expectNoteContaining(
          "Gateway service entrypoint does not match the current install.",
          "Gateway service config",
        );
        expect(mocks.note).toHaveBeenCalledWith(
          EXTERNAL_SERVICE_REPAIR_NOTE,
          "Gateway service config",
        );
        expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).not.toHaveBeenCalled();
      });
    },
  );

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
    mocks.isContainerEnvironment.mockReturnValue(false);
    mocks.findExtraGatewayServices.mockResolvedValue([]);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    mocks.isSystemdUnitActive.mockResolvedValue(ok(false));
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([]);
    mocks.execLaunchctl.mockReset().mockResolvedValue(launchctlResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockProcessPlatform(originalPlatform);
  });

  it.each([
    ["inactive", ok(false), "user", false],
    ["active", ok(true), "system", true],
    ["unknown", err("Failed to connect to bus: Permission denied"), "system", true],
  ] satisfies [string, Result<boolean, string>, "user" | "system", boolean][])(
    "reports non-legacy Linux gateway-like services with %s activity only when appropriate",
    async (_, active, scope, reported) => {
      mockProcessPlatform("linux");
      const { renderGatewayServiceCleanupHints } =
        await vi.importActual<typeof import("../daemon/inspect.js")>("../daemon/inspect.js");
      mocks.renderGatewayServiceCleanupHints.mockImplementation(renderGatewayServiceCleanupHints);
      const unitPath = `${scope === "user" ? "/home/test/.config/systemd/user" : "/etc/systemd/system"}/custom-gateway.service`;
      const service = {
        platform: "linux" as const,
        label: "custom-gateway.service",
        detail: `unit: ${unitPath}`,
        scope,
        legacy: false,
      };
      mocks.findExtraGatewayServices.mockResolvedValue([service]);
      mocks.isSystemdUnitActive.mockResolvedValue(active);

      await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

      expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
        process.env,
        "custom-gateway.service",
        scope,
      );
      if (reported) {
        expectNoteContaining("custom-gateway.service", "Other gateway-like services detected");
        expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalledWith([service]);
        expectNoteContaining(`${scope === "system" ? "sudo " : ""}rm ${unitPath}`, "Cleanup hints");
      } else {
        expectNoNoteContaining("custom-gateway.service", "Other gateway-like services detected");
      }
      expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
    },
  );

  it("renders cleanup hints only for the detected extra macOS gateway", async () => {
    mockProcessPlatform("darwin");
    const extraService = {
      platform: "darwin" as const,
      label: "com.example.openclaw-gateway",
      detail: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "user" as const,
      legacy: false,
    };
    mocks.findExtraGatewayServices.mockResolvedValue([extraService]);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([
      "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
    ]);

    await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

    expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalledWith([extraService]);
    expectNoteContaining("com.example.openclaw-gateway", "Cleanup hints");
    expectNoNoteContaining("ai.openclaw.gateway", "Cleanup hints");
  });

  it("does not render generic cleanup hints for legacy gateway services", async () => {
    setupLegacyMacService();
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);

    await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), {
      ...makeDoctorPrompts(),
      confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
    });

    expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalledWith([]);
    expectNoNoteContaining("ai.openclaw.gateway", "Cleanup hints");
  });

  it("threads deep scans through structured extra gateway service detection", async () => {
    mocks.findExtraGatewayServices.mockResolvedValue([]);

    await detectExtraGatewayServiceIssues({ deep: true });

    expect(mocks.findExtraGatewayServices).toHaveBeenCalledWith(process.env, { deep: true });
  });

  it("skips structured host-service discovery in containers without an OpenClaw service", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);

    await expect(detectExtraGatewayServiceIssues({ deep: true })).resolves.toEqual([]);

    expect(mocks.findExtraGatewayServices).not.toHaveBeenCalled();
    expect(mocks.isSystemdUnitActive).not.toHaveBeenCalled();
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
    ["timeouts", launchctlResult({ code: 124, termination: "timeout" })],
    ["unknown failures", launchctlResult({ code: 1, stderr: "Permission denied" })],
  ])("keeps the plist when both launchctl calls end in %s", async (_, failure) => {
    setupLegacyMacService();
    mocks.execLaunchctl.mockResolvedValue(failure);
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
    mocks.execLaunchctl
      .mockResolvedValueOnce(launchctlResult({ code: 124, termination: "timeout" }))
      .mockResolvedValueOnce(launchctlResult())
      .mockResolvedValueOnce(launchctlResult({ stdout: "state = waiting\npid = 0\n" }))
      .mockResolvedValueOnce(launchctlResult({ code: 1, stderr: "Permission denied" }));
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const access = vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    const runtime = makeDoctorIo();

    await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());

    expect(mocks.execLaunchctl).toHaveBeenCalledTimes(4);
    expect(mkdir).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (launchctl could not confirm unload)`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
  });

  it.each(["timeout", "signal"] as const)(
    "keeps the plist when the postcondition probe ends with %s",
    async (termination) => {
      setupLegacyMacService();
      mocks.execLaunchctl
        .mockResolvedValueOnce(launchctlResult())
        .mockResolvedValueOnce(launchctlResult())
        .mockResolvedValueOnce(
          launchctlResult({ code: 124, termination, stderr: "Could not find service" }),
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
    },
  );

  it.skipIf(process.platform === "win32").each([false, true])(
    "uses real command outcomes for legacy cleanup (signal=%s)",
    async (signal) => {
      setupLegacyMacService();
      const actual = await vi.importActual<typeof import("../daemon/launchd-exec.js")>(
        "../daemon/launchd-exec.js",
      );
      mocks.execLaunchctl.mockImplementation(actual.execLaunchctl);
      await withTempDir("openclaw-doctor-launchctl-", async (dir) => {
        await fs.writeFile(
          path.join(dir, "launchctl"),
          `#!/bin/sh\nif [ "$1" = print ]; then\n  printf 'Could not find service\\n' >&2\n  ${signal ? "kill -TERM $$" : "exit 113"}\nfi\nexit 0\n`,
          { mode: 0o700 },
        );
        vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
        vi.spyOn(fs, "access").mockResolvedValue(undefined);
        const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
        await withEnvAsync({ PATH: dir }, async () => {
          await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());
        });
        expect(rename).toHaveBeenCalledTimes(signal ? 0 : 1);
        expectNoteContaining(
          LEGACY_MAC_LABEL,
          signal ? "Legacy gateway cleanup skipped" : "Legacy gateway removed",
        );
      });
    },
  );

  it("polls a still-registered stopped label until launchd reports it gone", async () => {
    setupLegacyMacService();
    mocks.execLaunchctl
      .mockResolvedValueOnce(launchctlResult())
      .mockResolvedValueOnce(launchctlResult())
      .mockResolvedValueOnce(launchctlResult({ stdout: "state = waiting\npid = 0\n" }))
      .mockResolvedValueOnce(launchctlResult({ code: 113, stderr: "Could not find service" }));
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);

    await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

    expect(mocks.execLaunchctl).toHaveBeenCalledTimes(4);
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

describe("maybeResolveDuelingSystemdGatewayScopes", () => {
  const duelingInstallation = {
    kind: "dueling" as const,
    user: {
      scope: "user" as const,
      unitName: "openclaw-gateway.service",
      unitPath: "/home/test/.config/systemd/user/openclaw-gateway.service",
    },
    system: {
      scope: "system" as const,
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSystemdGatewayInstallation.mockResolvedValue({ kind: "none" });
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  });

  afterEach(() => {
    mockProcessPlatform(originalPlatform);
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  });

  it("removes the user-scope unit and keeps the system unit when confirmed", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
    mocks.uninstallUserSystemdGatewayUnit.mockResolvedValue({
      unitName: "openclaw-gateway.service",
      unitPath: duelingInstallation.user.unitPath,
      removed: true,
      disabled: true,
    });
    const runtime = makeDoctorIo();
    const prompter = makeDoctorPrompts();

    await maybeResolveDuelingSystemdGatewayScopes(runtime, prompter);

    expect(mocks.uninstallUserSystemdGatewayUnit).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "Removed the redundant user-scope gateway unit. The system-scope unit is now the sole gateway manager.",
    );
  });

  it("emits cleanup hints and does not remove anything when declined", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([
      "systemctl --user disable --now openclaw-gateway.service",
      "rm ~/.config/systemd/user/openclaw-gateway.service",
    ]);
    const prompter = makeDoctorPrompts();
    prompter.confirmRuntimeRepair = vi.fn().mockResolvedValue(false);

    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);

    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
    expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalled();
  });

  it.each(["OPENCLAW_SERVICE_REPAIR_POLICY", "OPENCLAW_SUPERVISOR_MODE"])(
    "skips removal and repair confirmation when %s is external",
    async (envKey) => {
      mockProcessPlatform("linux");
      mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
      mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
      const prompter = makeDoctorPrompts();

      await withEnvAsync({ [envKey]: "external" }, async () => {
        await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);
      });

      expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
      expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
      expect(mocks.note).toHaveBeenCalledWith(
        EXTERNAL_SERVICE_REPAIR_NOTE,
        "Gateway cleanup skipped",
      );
    },
  );

  it("keeps the user unit when the system unit is enabled but not running", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(false);
    const prompter = makeDoctorPrompts();

    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);

    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not verify the system-scope unit is both running and enabled at boot",
      ),
      "Gateway cleanup needs an owner decision",
    );
  });

  it("tells the operator to stop the unit when systemctl could not disable it", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
    mocks.uninstallUserSystemdGatewayUnit.mockResolvedValue({
      unitName: "openclaw-gateway.service",
      unitPath: duelingInstallation.user.unitPath,
      removed: true,
      disabled: false,
    });
    const runtime = makeDoctorIo();

    await maybeResolveDuelingSystemdGatewayScopes(runtime, makeDoctorPrompts());

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("systemctl --user disable --now openclaw-gateway.service"),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("sole gateway manager"));
  });

  it("fails closed when the system unit ownership probe errors", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockRejectedValue(new Error("systemctl wedged"));
    const prompter = makeDoctorPrompts();

    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);

    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
  });

  it("does nothing for a single-scope (user-only) install", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue({
      kind: "user",
      user: duelingInstallation.user,
    });

    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), makeDoctorPrompts());

    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
  });

  it("does nothing on non-Linux platforms", async () => {
    mockProcessPlatform("darwin");

    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), makeDoctorPrompts());

    expect(mocks.findSystemdGatewayInstallation).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
