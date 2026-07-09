// Doctor health contribution tests cover plugin-provided health checks.
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import "./doctor-tool-result-cap-advice.js";
import {
  createDoctorHealthContribution,
  resolveDoctorContributionHealthChecks,
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor-health-contributions.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  registerBundledHealthChecks: vi.fn(),
  runDoctorHealthRepairs: vi.fn(),
  maybeRepairLegacyFlatAuthProfileStores: vi.fn().mockResolvedValue(undefined),
  maybeRepairCanonicalApiKeyFieldAlias: vi.fn().mockResolvedValue(undefined),
  maybeRepairGatewayDaemon: vi.fn().mockResolvedValue(undefined),
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (cfg: unknown) => cfg),
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn().mockResolvedValue(undefined),
  collectAuthProfileHealthFindings: vi.fn(async () => []),
  noteAuthProfileHealth: vi.fn().mockResolvedValue(undefined),
  noteLegacyCodexProviderOverride: vi.fn(),
  noteMemorySearchHealth: vi.fn().mockResolvedValue(undefined),
  buildGatewayConnectionDetails: vi.fn(() => ({ message: "gateway details" })),
  callGateway: vi.fn(),
  resolveSecretInputRef: vi.fn((params: { value?: unknown }) => ({
    ref:
      params.value === "exec-token"
        ? { source: "exec", command: "printf token", cache: false }
        : undefined,
  })),
  resolveGatewayAuth: vi.fn(() => ({ mode: "token", token: undefined })),
  resolveGatewayAuthToken: vi.fn(async () => ({
    source: "unavailable",
    unresolvedRefReason: "exec provider failed",
  })),
  getSkippedExecRefStaticError: vi.fn(() => undefined),
  maybeRepairGatewayServiceConfig: vi.fn().mockResolvedValue(undefined),
  maybeScanExtraGatewayServices: vi.fn().mockResolvedValue(undefined),
  noteMacLaunchAgentOverrides: vi.fn(),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn(),
  noteMacStaleOpenClawUpdateLaunchdJobs: vi.fn(),
  gatewaySecretInputPathCanWin: vi.fn(),
  readGatewaySecretInputValue: vi.fn((..._args: unknown[]) => undefined as string | undefined),
  checkGatewayHealth: vi.fn(async () => ({
    authenticated: true,
    healthOk: true,
    status: { ok: true },
  })),
  probeGatewayMemoryStatus: vi.fn(async () => ({ checked: true, ready: true, skipped: false })),
  listHealthChecks: vi.fn(),
  getHealthCheck: vi.fn(),
  registerHealthCheck: vi.fn(),
  noteChromeMcpBrowserReadiness: vi.fn(),
  detectLegacyStateMigrations: vi.fn(),
  runLegacyStateMigrations: vi.fn(),
  collectLegacyPluginManifestContractMigrations: vi.fn(() => [] as unknown[]),
  legacyPluginManifestContractMigrationToHealthFinding: vi.fn(
    (migration: { pluginId: string }) => ({
      checkId: "core/doctor/legacy-plugin-manifests",
      severity: "warning" as const,
      message: `Plugin manifest ${migration.pluginId} uses legacy top-level capability keys.`,
      path: "/tmp/openclaw-plugin/openclaw.plugin.json",
      target: migration.pluginId,
      requirement: "contracts-capability-keys",
    }),
  ),
  maybeRepairLegacyPluginManifestContracts: vi.fn().mockResolvedValue(undefined),
  detectLegacyClawdBrowserProfileResidue: vi.fn(),
  maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
  resolveAgentContextLimits: vi.fn(
    (cfg: { agents?: { defaults?: { contextLimits?: unknown } } }) =>
      cfg.agents?.defaults?.contextLimits ?? {},
  ),
  note: vi.fn(),
  loadModelCatalog: vi.fn(async () => []),
  findModelCatalogEntry: vi.fn(() => ({ contextTokens: 200_000 })),
  getModelRefStatus: vi.fn(() => ({ allowed: true, inCatalog: true, key: "openai/gpt-5.5" })),
  resolveConfiguredModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveHooksGmailModel: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  modelKey: vi.fn((provider: string, model: string) => `${provider}/${model}`),
  replaceConfigFile: vi.fn().mockResolvedValue(undefined),
  readConfigFileSnapshot: vi.fn().mockResolvedValue({
    exists: true,
    valid: true,
    config: {},
    issues: [],
  }),
  gatherDaemonStatus: vi.fn(),
  noteWorkspaceStatus: vi.fn(),
  collectWorkspaceStatusHealthFindings: vi.fn().mockResolvedValue([]),
  collectWorkspaceBackupTip: vi.fn((): string | undefined => undefined),
  shouldSuggestMemorySystem: vi.fn(async () => false),
  collectDiskSpaceHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  collectHeartbeatTemplateHealthFindings: vi.fn(async () => [] as unknown[]),
  maybeRepairHeartbeatTemplate: vi.fn().mockResolvedValue(undefined),
  collectWhatsappResponsivenessHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  noteWhatsappResponsivenessHealth: vi.fn().mockResolvedValue(undefined),
  collectDevicePairingHealthFindings: vi.fn(async () => []),
  collectLegacyCronStoreHealthFindings: vi.fn(async (): Promise<readonly HealthFinding[]> => []),
  collectLegacyWhatsAppCrontabHealthWarning: vi.fn(
    async (): Promise<string | undefined> => undefined,
  ),
  maybeRepairLegacyCronStore: vi.fn().mockResolvedValue(undefined),
  noteLegacyWhatsAppCrontabHealthCheck: vi.fn().mockResolvedValue(undefined),
  scanConfiguredChannelPluginBlockers: vi.fn(
    (): Array<{ channelId: string; pluginId: string; reason: string }> => [],
  ),
  channelPluginBlockerHitToHealthFinding: vi.fn(
    (hit: { channelId: string; pluginId: string; reason: string }) => ({
      checkId: "core/doctor/channel-plugin-blockers",
      severity: "warning" as const,
      message: "channels." + hit.channelId + " blocked",
      path: "channels." + hit.channelId,
      target: hit.pluginId,
      requirement: hit.reason,
    }),
  ),
  collectStalePluginRuntimeSymlinkHealthFindings: vi.fn(async () => [] as unknown[]),
  collectChannelPreviewWarningHealthFindings: vi.fn(
    async (): Promise<readonly HealthFinding[]> => [],
  ),
  applyWizardMetadata: vi.fn((cfg: unknown) => cfg),
  logConfigUpdated: vi.fn(),
  isRecord: vi.fn(
    (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  shortenHomePath: vi.fn((p: string) => p),
  formatCliCommand: vi.fn((cmd: string) => cmd),
  isSystemdUserServiceAvailable: vi.fn(async () => true),
  readSystemdUserLingerStatus: vi.fn(async () => ({ user: "alice", linger: "no" as const })),
  gatewayServiceIsLoaded: vi.fn(async () => true),
  resolveGatewayService: vi.fn(),
  getSkillCuratorDoctorWarning: vi.fn(),
}));

const DOCTOR_GATEWAY_HEALTH_ID = "doctor:gateway-health";

vi.mock("../commands/doctor/shared/release-configured-plugin-installs.js", () => ({
  maybeRunConfiguredPluginInstallReleaseStep: mocks.maybeRunConfiguredPluginInstallReleaseStep,
}));

vi.mock("../commands/doctor/shared/plugin-runtime-symlinks.js", () => ({
  collectStalePluginRuntimeSymlinkHealthFindings:
    mocks.collectStalePluginRuntimeSymlinkHealthFindings,
}));

vi.mock("./bundled-health-checks.js", () => ({
  registerBundledHealthChecks: mocks.registerBundledHealthChecks,
}));

vi.mock("../skills/workshop/curator.js", () => ({
  getSkillCuratorDoctorWarning: mocks.getSkillCuratorDoctorWarning,
}));

vi.mock("./doctor-repair-flow.js", () => ({
  runDoctorHealthRepairs: mocks.runDoctorHealthRepairs,
}));

vi.mock("../config/types.secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/types.secrets.js")>();
  return {
    ...actual,
    resolveSecretInputRef: mocks.resolveSecretInputRef,
  };
});

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

vi.mock("../gateway/auth-token-resolution.js", () => ({
  resolveGatewayAuthToken: mocks.resolveGatewayAuthToken,
}));

vi.mock("../secrets/exec-resolution-policy.js", () => ({
  getSkippedExecRefStaticError: mocks.getSkippedExecRefStaticError,
}));

vi.mock("../commands/doctor-gateway-services.js", () => ({
  maybeRepairGatewayServiceConfig: mocks.maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices: mocks.maybeScanExtraGatewayServices,
}));

vi.mock("../commands/doctor-auth-flat-profiles.js", () => ({
  maybeRepairLegacyFlatAuthProfileStores: mocks.maybeRepairLegacyFlatAuthProfileStores,
  maybeRepairCanonicalApiKeyFieldAlias: mocks.maybeRepairCanonicalApiKeyFieldAlias,
}));

vi.mock("../commands/doctor-gateway-daemon-flow.js", () => ({
  maybeRepairGatewayDaemon: mocks.maybeRepairGatewayDaemon,
}));

vi.mock("../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    resolveGatewayService: mocks.resolveGatewayService,
  };
});

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
    readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
  };
});

vi.mock("../commands/doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: mocks.maybeRepairLegacyOAuthProfileIds,
}));

vi.mock("../commands/doctor-state-migrations.js", () => ({
  detectLegacyStateMigrations: mocks.detectLegacyStateMigrations,
  runLegacyStateMigrations: mocks.runLegacyStateMigrations,
}));

vi.mock("../commands/doctor-plugin-manifests.js", () => ({
  collectLegacyPluginManifestContractMigrations:
    mocks.collectLegacyPluginManifestContractMigrations,
  legacyPluginManifestContractMigrationToHealthFinding:
    mocks.legacyPluginManifestContractMigrationToHealthFinding,
  maybeRepairLegacyPluginManifestContracts: mocks.maybeRepairLegacyPluginManifestContracts,
}));

vi.mock("../commands/doctor-auth-oauth-sidecar.js", () => ({
  maybeRepairLegacyOAuthSidecarProfiles: mocks.maybeRepairLegacyOAuthSidecarProfiles,
}));

vi.mock("../commands/doctor-auth.js", () => ({
  collectAuthProfileHealthFindings: mocks.collectAuthProfileHealthFindings,
  noteAuthProfileHealth: mocks.noteAuthProfileHealth,
  noteLegacyCodexProviderOverride: mocks.noteLegacyCodexProviderOverride,
}));

vi.mock("../commands/doctor-memory-search.js", () => ({
  maybeRepairMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemorySearchHealth: mocks.noteMemorySearchHealth,
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
  callGateway: mocks.callGateway,
}));

vi.mock("../commands/doctor-platform-notes.js", () => ({
  noteMacLaunchAgentOverrides: mocks.noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides: mocks.noteMacLaunchctlGatewayEnvOverrides,
  noteMacStaleOpenClawUpdateLaunchdJobs: mocks.noteMacStaleOpenClawUpdateLaunchdJobs,
}));

vi.mock("../gateway/credentials-secret-inputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/credentials-secret-inputs.js")>();
  return {
    ...actual,
    gatewaySecretInputPathCanWin: (
      ...args: Parameters<typeof actual.gatewaySecretInputPathCanWin>
    ) =>
      mocks.gatewaySecretInputPathCanWin.getMockImplementation()
        ? mocks.gatewaySecretInputPathCanWin(...args)
        : actual.gatewaySecretInputPathCanWin(...args),
  };
});

vi.mock("../gateway/secret-input-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/secret-input-paths.js")>();
  return {
    ...actual,
    readGatewaySecretInputValue: (...args: Parameters<typeof actual.readGatewaySecretInputValue>) =>
      mocks.readGatewaySecretInputValue.getMockImplementation()
        ? mocks.readGatewaySecretInputValue(...args)
        : actual.readGatewaySecretInputValue(...args),
  };
});

vi.mock("../commands/doctor-gateway-health.js", () => ({
  checkGatewayHealth: mocks.checkGatewayHealth,
  probeGatewayMemoryStatus: mocks.probeGatewayMemoryStatus,
}));

vi.mock("./health-check-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./health-check-registry.js")>();
  return {
    ...actual,
    listHealthChecks: mocks.listHealthChecks,
    listExtensionHealthChecksForDoctor: (
      coreChecks: Parameters<typeof actual.listExtensionHealthChecksForDoctor>[0],
    ) => {
      const coreIds = new Set(coreChecks.map((check) => check.id));
      const registeredChecks = mocks.listHealthChecks() as readonly HealthCheck[];
      for (const check of registeredChecks) {
        if (check.id.startsWith("core/doctor/") || coreIds.has(check.id)) {
          throw new actual.HealthCheckRegistrationError(check.id);
        }
      }
      return registeredChecks.filter((check) => check.kind !== "core");
    },
    getHealthCheck: mocks.getHealthCheck,
    registerHealthCheck: mocks.registerHealthCheck,
  };
});

vi.mock("../commands/doctor-browser.js", () => ({
  noteChromeMcpBrowserReadiness: mocks.noteChromeMcpBrowserReadiness,
  detectLegacyClawdBrowserProfileResidue: mocks.detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue: mocks.maybeArchiveLegacyClawdBrowserProfileResidue,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentContextLimits: mocks.resolveAgentContextLimits,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
  findModelCatalogEntry: mocks.findModelCatalogEntry,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: mocks.getModelRefStatus,
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
  resolveHooksGmailModel: mocks.resolveHooksGmailModel,
  modelKey: mocks.modelKey,
}));

vi.mock("../version.js", async () => ({
  ...(await vi.importActual<typeof import("../version.js")>("../version.js")),
  VERSION: "2026.5.2-test",
  resolveCompatibilityHostVersion: vi.fn(() => "2026.5.2-test"),
  resolveIsNixMode: vi.fn(() => false),
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/fake-openclaw.json",
  replaceConfigFile: mocks.replaceConfigFile,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../commands/doctor-gateway-health.js", () => ({
  checkGatewayHealth: mocks.checkGatewayHealth,
  probeGatewayMemoryStatus: mocks.probeGatewayMemoryStatus,
}));

vi.mock("../cli/daemon-cli/status.gather.js", () => ({
  gatherDaemonStatus: mocks.gatherDaemonStatus,
}));

vi.mock("../commands/doctor-workspace-status.js", () => ({
  noteWorkspaceStatus: mocks.noteWorkspaceStatus,
  collectWorkspaceStatusHealthFindings: mocks.collectWorkspaceStatusHealthFindings,
}));

vi.mock("../commands/doctor-state-integrity.js", () => ({
  collectWorkspaceBackupTip: mocks.collectWorkspaceBackupTip,
  noteWorkspaceBackupTip: vi.fn(),
}));

vi.mock("../commands/doctor-workspace.js", () => ({
  MEMORY_SYSTEM_PROMPT: "Enable memory system for better recall.",
  shouldSuggestMemorySystem: mocks.shouldSuggestMemorySystem,
}));

vi.mock("../commands/doctor-disk-space.js", () => ({
  noteDiskSpace: vi.fn(),
  collectDiskSpaceHealthFindings: mocks.collectDiskSpaceHealthFindings,
}));

vi.mock("../commands/doctor-heartbeat-template-repair.js", () => ({
  collectHeartbeatTemplateHealthFindings: mocks.collectHeartbeatTemplateHealthFindings,
  maybeRepairHeartbeatTemplate: mocks.maybeRepairHeartbeatTemplate,
}));

vi.mock("../commands/doctor-whatsapp-responsiveness.js", () => ({
  collectWhatsappResponsivenessHealthFindings: mocks.collectWhatsappResponsivenessHealthFindings,
  noteWhatsappResponsivenessHealth: mocks.noteWhatsappResponsivenessHealth,
}));

vi.mock("../commands/doctor-device-pairing.js", () => ({
  collectDevicePairingHealthFindings: mocks.collectDevicePairingHealthFindings,
  noteDevicePairingHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands/doctor/cron/index.js", () => ({
  collectLegacyCronStoreHealthFindings: mocks.collectLegacyCronStoreHealthFindings,
  collectLegacyWhatsAppCrontabHealthWarning: mocks.collectLegacyWhatsAppCrontabHealthWarning,
  maybeRepairLegacyCronStore: mocks.maybeRepairLegacyCronStore,
  noteLegacyWhatsAppCrontabHealthCheck: mocks.noteLegacyWhatsAppCrontabHealthCheck,
}));

vi.mock("../commands/doctor/shared/channel-plugin-blockers.js", () => ({
  scanConfiguredChannelPluginBlockers: mocks.scanConfiguredChannelPluginBlockers,
  channelPluginBlockerHitToHealthFinding: mocks.channelPluginBlockerHitToHealthFinding,
}));

vi.mock("./doctor-startup-channel-maintenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-startup-channel-maintenance.js")>();
  return {
    ...actual,
    collectChannelPreviewWarningHealthFindings: mocks.collectChannelPreviewWarningHealthFindings,
  };
});

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: mocks.applyWizardMetadata,
  randomToken: vi.fn(() => "generated-gateway-token"),
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    isRecord: mocks.isRecord,
    resolveConfigDir: vi.fn(() => "/tmp/openclaw-config"),
    resolveUserPath: vi.fn((value: string) => value),
    shortenHomePath: mocks.shortenHomePath,
  };
});

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: mocks.formatCliCommand,
}));

vi.mock("../commands/doctor-gateway-services.js", () => ({
  maybeRepairGatewayServiceConfig: mocks.maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices: mocks.maybeScanExtraGatewayServices,
}));

vi.mock("../commands/doctor-platform-notes.js", () => ({
  noteMacLaunchAgentOverrides: mocks.noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides: mocks.noteMacLaunchctlGatewayEnvOverrides,
  noteMacStaleOpenClawUpdateLaunchdJobs: mocks.noteMacStaleOpenClawUpdateLaunchdJobs,
}));

function requireDoctorContribution(id: string) {
  const contribution = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`expected doctor contribution ${id}`);
  }
  return contribution;
}

type DoctorContributionRunContext = Parameters<
  ReturnType<typeof requireDoctorContribution>["run"]
>[0];

function buildDoctorPrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: false,
    },
  };
}

describe("doctor health contributions", () => {
  async function withProcessPlatform<T>(
    platform: NodeJS.Platform,
    run: () => Promise<T>,
  ): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return await run();
    } finally {
      if (original) {
        Object.defineProperty(process, "platform", original);
      }
    }
  }

  beforeEach(() => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.registerBundledHealthChecks.mockReset();
    mocks.runDoctorHealthRepairs.mockReset();
    mocks.maybeRepairLegacyFlatAuthProfileStores.mockClear();
    mocks.maybeRepairLegacyFlatAuthProfileStores.mockResolvedValue(undefined);
    mocks.maybeRepairCanonicalApiKeyFieldAlias.mockClear();
    mocks.maybeRepairCanonicalApiKeyFieldAlias.mockResolvedValue(undefined);
    mocks.maybeRepairGatewayDaemon.mockClear();
    mocks.maybeRepairGatewayDaemon.mockResolvedValue(undefined);
    mocks.maybeRepairLegacyOAuthProfileIds.mockClear();
    mocks.maybeRepairLegacyOAuthProfileIds.mockImplementation(async (cfg: unknown) => cfg);
    mocks.collectLegacyPluginManifestContractMigrations.mockReset();
    mocks.collectLegacyPluginManifestContractMigrations.mockReturnValue([]);
    mocks.legacyPluginManifestContractMigrationToHealthFinding.mockClear();
    mocks.maybeRepairLegacyPluginManifestContracts.mockClear();
    mocks.maybeRepairLegacyPluginManifestContracts.mockResolvedValue(undefined);
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockClear();
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockResolvedValue(undefined);
    mocks.collectAuthProfileHealthFindings.mockClear();
    mocks.collectAuthProfileHealthFindings.mockResolvedValue([]);
    mocks.noteAuthProfileHealth.mockClear();
    mocks.noteAuthProfileHealth.mockResolvedValue(undefined);
    mocks.noteLegacyCodexProviderOverride.mockClear();
    mocks.noteMemorySearchHealth.mockClear();
    mocks.noteMemorySearchHealth.mockResolvedValue(undefined);
    mocks.buildGatewayConnectionDetails.mockClear();
    mocks.buildGatewayConnectionDetails.mockReturnValue({ message: "gateway details" });
    mocks.callGateway.mockReset();
    mocks.callGateway.mockResolvedValue({});
    mocks.resolveSecretInputRef.mockClear();
    mocks.resolveGatewayAuth.mockClear();
    mocks.resolveGatewayAuth.mockReturnValue({ mode: "token", token: undefined });
    mocks.resolveGatewayAuthToken.mockClear();
    mocks.resolveGatewayAuthToken.mockResolvedValue({
      source: "unavailable",
      unresolvedRefReason: "exec provider failed",
    });
    mocks.getSkippedExecRefStaticError.mockClear();
    mocks.getSkippedExecRefStaticError.mockReturnValue(undefined);
    mocks.maybeRepairGatewayServiceConfig.mockClear();
    mocks.maybeRepairGatewayServiceConfig.mockResolvedValue(undefined);
    mocks.maybeScanExtraGatewayServices.mockClear();
    mocks.maybeScanExtraGatewayServices.mockResolvedValue(undefined);
    mocks.noteMacLaunchAgentOverrides.mockClear();
    mocks.noteMacLaunchctlGatewayEnvOverrides.mockClear();
    mocks.noteMacStaleOpenClawUpdateLaunchdJobs.mockClear();
    mocks.gatewaySecretInputPathCanWin.mockClear();
    mocks.gatewaySecretInputPathCanWin.mockReset();
    mocks.readGatewaySecretInputValue.mockClear();
    mocks.readGatewaySecretInputValue.mockReset();
    mocks.checkGatewayHealth.mockClear();
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: true,
      healthOk: true,
      status: { ok: true },
    });
    mocks.probeGatewayMemoryStatus.mockClear();
    mocks.probeGatewayMemoryStatus.mockResolvedValue({
      checked: true,
      ready: true,
      skipped: false,
    });
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      findings: [],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 0,
      checksRepaired: 0,
      checksValidated: 0,
    });
    mocks.listHealthChecks.mockReset();
    mocks.listHealthChecks.mockReturnValue([
      { id: "core/example/internal", kind: "core" },
      { id: "plugin/example/unrelated", kind: "plugin" },
    ]);
    mocks.getHealthCheck.mockReset();
    mocks.getHealthCheck.mockReturnValue(undefined);
    mocks.registerHealthCheck.mockReset();
    mocks.noteChromeMcpBrowserReadiness.mockReset();
    mocks.noteChromeMcpBrowserReadiness.mockResolvedValue(undefined);
    mocks.detectLegacyStateMigrations.mockReset();
    mocks.detectLegacyStateMigrations.mockResolvedValue({ preview: [], warnings: [] });
    mocks.runLegacyStateMigrations.mockReset();
    mocks.runLegacyStateMigrations.mockResolvedValue({ changes: [], warnings: [] });
    mocks.detectLegacyClawdBrowserProfileResidue.mockReset();
    mocks.detectLegacyClawdBrowserProfileResidue.mockReturnValue(null);
    mocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockReset();
    mocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.resolveAgentWorkspaceDir.mockReset();
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    mocks.resolveDefaultAgentId.mockReset();
    mocks.resolveDefaultAgentId.mockReturnValue("default");
    mocks.resolveAgentContextLimits.mockReset();
    mocks.resolveAgentContextLimits.mockImplementation(
      (cfg: { agents?: { defaults?: { contextLimits?: unknown } } }) =>
        cfg.agents?.defaults?.contextLimits ?? {},
    );
    mocks.note.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.loadModelCatalog.mockResolvedValue([]);
    mocks.findModelCatalogEntry.mockReset();
    mocks.findModelCatalogEntry.mockReturnValue({ contextTokens: 200_000 });
    mocks.getModelRefStatus.mockReset();
    mocks.getModelRefStatus.mockReturnValue({
      allowed: true,
      inCatalog: true,
      key: "openai/gpt-5.5",
    });
    mocks.resolveConfiguredModelRef.mockReset();
    mocks.resolveConfiguredModelRef.mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.resolveDefaultModelForAgent.mockReset();
    mocks.resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.resolveHooksGmailModel.mockReset();
    mocks.resolveHooksGmailModel.mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.modelKey.mockReset();
    mocks.modelKey.mockImplementation((provider: string, model: string) => `${provider}/${model}`);
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.checkGatewayHealth.mockReset();
    mocks.probeGatewayMemoryStatus.mockReset();
    mocks.gatherDaemonStatus.mockReset();
    mocks.gatherDaemonStatus.mockResolvedValue({});
    mocks.noteWorkspaceStatus.mockReset();
    mocks.resolveGatewayService.mockReset();
    mocks.resolveGatewayService.mockReturnValue({ isLoaded: mocks.gatewayServiceIsLoaded });
    mocks.gatewayServiceIsLoaded.mockReset();
    mocks.gatewayServiceIsLoaded.mockResolvedValue(true);
    mocks.collectWorkspaceStatusHealthFindings.mockReset();
    mocks.collectWorkspaceStatusHealthFindings.mockResolvedValue([]);
    mocks.collectDiskSpaceHealthFindings.mockReset();
    mocks.collectDiskSpaceHealthFindings.mockReturnValue([]);
    mocks.collectHeartbeatTemplateHealthFindings.mockReset();
    mocks.collectHeartbeatTemplateHealthFindings.mockResolvedValue([]);
    mocks.maybeRepairHeartbeatTemplate.mockReset();
    mocks.maybeRepairHeartbeatTemplate.mockResolvedValue(undefined);
    mocks.collectWhatsappResponsivenessHealthFindings.mockReset();
    mocks.collectWhatsappResponsivenessHealthFindings.mockReturnValue([]);
    mocks.noteWhatsappResponsivenessHealth.mockReset();
    mocks.noteWhatsappResponsivenessHealth.mockResolvedValue(undefined);
    mocks.collectDevicePairingHealthFindings.mockReset();
    mocks.collectDevicePairingHealthFindings.mockResolvedValue([]);
    mocks.collectLegacyCronStoreHealthFindings.mockReset();
    mocks.collectLegacyCronStoreHealthFindings.mockResolvedValue([]);
    mocks.collectLegacyWhatsAppCrontabHealthWarning.mockReset();
    mocks.collectLegacyWhatsAppCrontabHealthWarning.mockResolvedValue(undefined);
    mocks.maybeRepairLegacyCronStore.mockReset();
    mocks.maybeRepairLegacyCronStore.mockResolvedValue(undefined);
    mocks.noteLegacyWhatsAppCrontabHealthCheck.mockReset();
    mocks.noteLegacyWhatsAppCrontabHealthCheck.mockResolvedValue(undefined);
    mocks.scanConfiguredChannelPluginBlockers.mockReset();
    mocks.scanConfiguredChannelPluginBlockers.mockReturnValue([]);
    mocks.channelPluginBlockerHitToHealthFinding.mockClear();
    mocks.collectStalePluginRuntimeSymlinkHealthFindings.mockReset();
    mocks.collectStalePluginRuntimeSymlinkHealthFindings.mockResolvedValue([]);
    mocks.collectChannelPreviewWarningHealthFindings.mockReset();
    mocks.collectChannelPreviewWarningHealthFindings.mockResolvedValue([]);
    mocks.isSystemdUserServiceAvailable.mockReset();
    mocks.isSystemdUserServiceAvailable.mockResolvedValue(true);
    mocks.readSystemdUserLingerStatus.mockReset();
    mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "alice", linger: "no" });
    mocks.replaceConfigFile.mockReset();
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.applyWizardMetadata.mockReset();
    mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
    mocks.maybeRepairGatewayServiceConfig.mockReset();
    mocks.maybeRepairGatewayServiceConfig.mockImplementation(async (cfg: unknown) => cfg);
    mocks.maybeScanExtraGatewayServices.mockReset();
    mocks.maybeScanExtraGatewayServices.mockResolvedValue(undefined);
    mocks.noteMacLaunchAgentOverrides.mockReset();
    mocks.noteMacLaunchAgentOverrides.mockResolvedValue(undefined);
    mocks.noteMacLaunchctlGatewayEnvOverrides.mockReset();
    mocks.noteMacLaunchctlGatewayEnvOverrides.mockResolvedValue(undefined);
    mocks.noteMacStaleOpenClawUpdateLaunchdJobs.mockReset();
    mocks.noteMacStaleOpenClawUpdateLaunchdJobs.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps legacy plugin manifest lint opt-in for structured findings", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-plugin-manifests");
    const check = contribution.healthChecks[0] as HealthCheck & { defaultEnabled?: boolean };
    expect(contribution.healthCheckIds).toEqual(["core/doctor/legacy-plugin-manifests"]);
    expect(check.defaultEnabled).toBe(false);

    const migration = {
      manifestPath: "/tmp/openclaw-plugin/openclaw.plugin.json",
      pluginId: "legacy-plugin",
      nextRaw: {},
      changeLines: ["- moved tools to contracts.tools"],
    };
    mocks.collectLegacyPluginManifestContractMigrations.mockReturnValueOnce([migration]);
    const ctx = {
      cfg: { plugins: { load: { paths: ["/tmp/openclaw-plugin"] } } },
      mode: "lint" as const,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    };

    await expect(runDoctorLintChecks(ctx, { checks: [check] })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectLegacyPluginManifestContractMigrations).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, {
        checks: [check],
        onlyIds: ["core/doctor/legacy-plugin-manifests"],
      }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/legacy-plugin-manifests",
          target: "legacy-plugin",
          requirement: "contracts-capability-keys",
        }),
      ],
    });
    expect(mocks.collectLegacyPluginManifestContractMigrations).toHaveBeenCalledWith({
      config: ctx.cfg,
      env: process.env,
    });
    expect(mocks.legacyPluginManifestContractMigrationToHealthFinding).toHaveBeenCalledWith(
      migration,
      expect.any(Number),
      expect.any(Array),
    );
  });

  it("runs release configured plugin install repair before plugin registry and final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("skips read-scope gateway probes when gateway health only proved reachability", async () => {
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: false,
      healthOk: true,
      status: { ok: true },
    });
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.healthOk).toBe(true);
    expect(ctx.gatewayHealthAuthenticated).toBe(false);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
    expect(mocks.probeGatewayMemoryStatus).not.toHaveBeenCalled();
  });

  it("skips remote gateway health probes for local fallback exec SecretRefs", async () => {
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: false,
      healthOk: true,
      status: { ok: true },
    });
    mocks.gatewaySecretInputPathCanWin.mockImplementation(
      ({ path }: { path: string }) => path === "gateway.auth.token",
    );
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const cfg = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };
    const ctx = {
      cfg,
      configResult: { cfg },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: cfg,
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health probes skipped"),
      "Gateway",
    );
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
  });

  it("skips local gateway health probes for remote fallback exec SecretRefs", async () => {
    mocks.gatewaySecretInputPathCanWin.mockImplementation(
      ({ path }: { path: string }) => path === "gateway.remote.token",
    );
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const cfg = {
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
        },
        remote: {
          token: { source: "exec", provider: "vault", id: "gateway/remote-token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };
    const ctx = {
      cfg,
      configResult: { cfg },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: cfg,
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health probes skipped"),
      "Gateway",
    );
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
  });

  it("keeps release configured plugin installs repair-only", async () => {
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("stamps release configured plugin installs after repair changes", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).toHaveBeenCalledWith({
      cfg: {},
      env: {},
      touchedVersion: "2026.4.29",
    });
    expect(mocks.note).toHaveBeenCalledWith(
      "Installed configured plugin matrix.",
      "Doctor changes",
    );
    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.2-test");
  });

  it("keeps legacy parent writable release repairs old-parent-readable", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.16-beta.4" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.16-beta.4");
    expect(ctx.cfg.meta?.lastTouchedAt).toEqual(expect.any(String));
  });

  it("checks command owner configuration before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:command-owner")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:command-owner")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("checks skill readiness before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:skills")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:skills")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("reports a wedged skill curator as a warning finding", async () => {
    mocks.getSkillCuratorDoctorWarning.mockReturnValueOnce(
      "skill curator has not completed a sweep since 2026-01-01 — check gateway logs",
    );
    const contribution = requireDoctorContribution("doctor:skill-curator");
    const check = contribution.healthChecks[0] as HealthCheck;
    const findings = await check.detect({
      cfg: {},
      mode: "doctor",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/skill-curator",
        severity: "warning",
        target: "skill-curator",
      }),
    ]);
  });

  it("keeps workspace status opt-in for structured lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const check = contribution.healthChecks[0] as HealthCheck & { defaultEnabled?: boolean };
    expect(contribution.healthCheckIds).toEqual(["core/doctor/workspace-status"]);
    expect(check.defaultEnabled).toBe(false);

    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm" as const,
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: "2026.6.1" },
      pluginVersionDrift,
    });
    mocks.collectWorkspaceStatusHealthFindings.mockResolvedValueOnce([
      {
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        message: "Plugin codex is stale.",
        path: "plugins.entries.codex",
      },
    ]);
    const ctx = {
      cfg: { plugins: { entries: { codex: { enabled: true } } } },
      mode: "lint",
      allowExecSecretRefs: true,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;

    await expect(runDoctorLintChecks(ctx, { checks: [check] })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectWorkspaceStatusHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks: [check], onlyIds: ["core/doctor/workspace-status"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/workspace-status" })],
    });
    expect(mocks.collectWorkspaceStatusHealthFindings).toHaveBeenCalledWith(ctx.cfg, {
      pluginVersionDrift,
    });
    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: true,
    });
  });

  it("passes daemon-context plugin drift into the workspace status note", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: "2026.6.1" },
      pluginVersionDrift,
    });
    const cfg = { plugins: { entries: { codex: { enabled: true } } } };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: false,
    });
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, { pluginVersionDrift });
  });

  it("omits daemon-context plugin drift when gateway version used the fallback", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.5.2-test",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.5.2-test",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: null },
      pluginVersionDrift,
    });
    const cfg = { plugins: { entries: { codex: { enabled: true } } } };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionDrift: undefined,
    });
  });

  it("omits daemon-context plugin drift when probe auth was skipped", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: {},
      rpc: { authWarning: "exec SecretRef probe auth skipped" },
      pluginVersionDrift,
    });
    const cfg = { plugins: { entries: { codex: { enabled: true } } } };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionDrift: undefined,
    });
  });

  it("skips daemon-context plugin drift probes for remote gateway mode", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const cfg = {
      gateway: { mode: "remote" },
      plugins: { entries: { codex: { enabled: true } } },
    };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).not.toHaveBeenCalled();
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionDrift: undefined,
    });
  });

  it("lets daemon status decide exec SecretRef probing from daemon config", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: "2026.6.1" },
      pluginVersionDrift,
    });
    const cfg = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "exec",
            provider: "vault",
            id: "gateway/token",
          },
        },
      },
    };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: false,
    });
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, { pluginVersionDrift });
  });

  it("ignores remote-only exec SecretRefs for local daemon-context plugin drift probes", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const cfg = {
      gateway: {
        auth: {
          mode: "token",
        },
        remote: {
          token: {
            source: "exec",
            provider: "vault",
            id: "gateway/remote-token",
          },
        },
      },
    };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: false,
    });
  });

  it("uses the read-only model catalog for hooks.gmail.model warnings", async () => {
    const contribution = requireDoctorContribution("doctor:hooks-model");
    const cfg = {
      hooks: {
        gmail: {
          model: "openai/gpt-5.5",
        },
      },
    };
    const ctx = {
      cfg,
      options: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({ config: cfg, readOnly: true });
  });

  it("repairs heartbeat templates before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:heartbeat-template-repair")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:heartbeat-template-repair")).toBeLessThan(
      ids.indexOf("doctor:write-config"),
    );
  });

  it("keeps heartbeat template lint opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const heartbeatTemplateCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/heartbeat-template",
    );
    expect(heartbeatTemplateCheck).toMatchObject({ defaultEnabled: false });
    expect(heartbeatTemplateCheck).toBeDefined();

    const ctx = {
      cfg: { agents: { defaults: { workspace: "/tmp/openclaw-workspace" } } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [heartbeatTemplateCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectHeartbeatTemplateHealthFindings).not.toHaveBeenCalled();

    mocks.collectHeartbeatTemplateHealthFindings.mockResolvedValueOnce([
      {
        checkId: "core/doctor/heartbeat-template",
        severity: "warning",
        message: "HEARTBEAT.md contains an older heartbeat documentation template.",
        path: "/tmp/openclaw-workspace/HEARTBEAT.md",
        requirement: "legacy-template",
      },
    ]);

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/heartbeat-template"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/heartbeat-template" })],
    });
    expect(mocks.collectHeartbeatTemplateHealthFindings).toHaveBeenCalledWith(ctx.cfg);
  });

  it("exposes the Skill Workshop tool-policy check to doctor lint", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const check = contributionChecks.find(
      (entry) => entry.id === "core/doctor/skill-workshop-tool-policy",
    );

    expect(check).toMatchObject({
      id: "core/doctor/skill-workshop-tool-policy",
      kind: "core",
    });
  });

  it("keeps default-account routing lint opt-in", async () => {
    const contribution = requireDoctorContribution("doctor:default-account-routing");
    const check = contribution.healthChecks[0] as HealthCheck | undefined;
    expect(check).toMatchObject({ defaultEnabled: false });

    const ctx = {
      cfg: {
        channels: {
          telegram: {
            accounts: {
              alerts: {},
              work: {},
            },
          },
        },
        bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
      } as unknown as OpenClawConfig,
      mode: "lint" as const,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    };

    await expect(runDoctorLintChecks(ctx, { checks: [check!] })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
      findings: [],
    });
    await expect(
      runDoctorLintChecks(ctx, { checks: [check!], includeAllChecks: true }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({ checkId: "core/doctor/default-account-routing" }),
        expect.objectContaining({ checkId: "core/doctor/default-account-routing" }),
      ],
    });
  });

  it("preserves allow-exec Gateway SecretRef resolution in auth health", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-auth");
    const ctx = {
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "exec-token" },
        },
      },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { allowExec: true, nonInteractive: true },
      env: { OPENCLAW_TEST_GATEWAY_TOKEN: "1" },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.resolveGatewayAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        env: ctx.env,
        unresolvedReasonStyle: "detailed",
        envFallback: "never",
      }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Gateway token SecretRef could not be resolved: exec provider failed",
      ),
      "Gateway auth",
    );
  });

  it("forwards allow-exec to Gateway service repair", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-services");
    const ctx = {
      cfg: { gateway: { mode: "local" } },
      configResult: {},
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { allowExec: true },
    } as unknown as DoctorContributionRunContext;

    await contribution.run(ctx);

    expect(mocks.maybeRepairGatewayServiceConfig).toHaveBeenCalledWith(
      ctx.cfg,
      "local",
      ctx.runtime,
      ctx.prompter,
      expect.objectContaining({ allowExecSecretRefs: true }),
    );
  });

  it("passes the active config into legacy state migration", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    const legacyStateCheck = CORE_HEALTH_CHECKS.find(
      (check) => check.id === "core/doctor/legacy-state",
    );
    expect(legacyStateCheck).toMatchObject({ defaultEnabled: false });

    const cfg = { session: { store: "/tmp/shared-sessions.json" } };
    const detected = { preview: ["legacy sessions"], warnings: [] };
    mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
    const ctx = {
      cfg,
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.runLegacyStateMigrations).toHaveBeenCalledWith({
      detected,
      config: cfg,
      recoverCorruptTargetStore: false,
    });
  });

  it("prints legacy state migration notices during manual doctor runs", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    const detected = { preview: ["legacy sessions"], warnings: [] };
    mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
    mocks.runLegacyStateMigrations.mockResolvedValue({
      changes: [],
      warnings: [],
      notices: ["Left reviewed legacy residue in place."],
    });
    const ctx = {
      cfg: {},
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.note).toHaveBeenCalledWith(
      "Left reviewed legacy residue in place.",
      "Doctor notices",
    );
  });

  it("skips Gateway health probes for exec SecretRefs unless allow-exec is set", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-health");
    mocks.gatewaySecretInputPathCanWin.mockImplementation(
      ({ path }: { path: string }) => path === "gateway.auth.token",
    );
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
    const ctx = {
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "exec-token" },
        },
      },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health probes skipped"),
      "Gateway",
    );
  });

  it("keeps canonical api_key alias repair wired through auth profile health", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const ctx = {
      cfg: {},
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRepairLegacyFlatAuthProfileStores).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
    });
    expect(mocks.maybeRepairCanonicalApiKeyFieldAlias).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
    });
  });

  it("registers auth profile health as an opt-in structured check", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const [check] = contribution.healthChecks;

    expect(contribution.healthCheckIds).toEqual(["core/doctor/auth-profiles"]);
    expect(check).toMatchObject({
      id: "core/doctor/auth-profiles",
      kind: "core",
      defaultEnabled: false,
    });
    if (!check || !("detect" in check)) {
      throw new Error("expected split auth profile health check");
    }

    await check.detect({
      mode: "lint",
      cfg: { auth: { profiles: {} } },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    expect(mocks.collectAuthProfileHealthFindings).toHaveBeenCalledWith({
      cfg: { auth: { profiles: {} } },
      allowKeychainPrompt: false,
    });
  });

  it("forwards skipped Gateway health to daemon repair", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-daemon");
    const ctx = {
      cfg: {},
      gatewayDetails: { message: "gateway details" },
      gatewayHealthSkipped: true,
      healthOk: false,
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRepairGatewayDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        prompter: ctx.prompter,
        options: ctx.options,
        gatewayDetailsMessage: "gateway details",
        healthOk: false,
        healthSkipped: true,
      }),
    );
  });

  it("keeps implemented core health checks owned by ordered doctor contributions", async () => {
    const coreIds = CORE_HEALTH_CHECKS.map((check) => check.id);
    const contributionIds = resolveDoctorHealthContributions().flatMap(
      (entry) => entry.healthCheckIds,
    );
    const contributionChecks = await resolveDoctorContributionHealthChecks();

    for (const coreId of coreIds) {
      expect(contributionIds).toContain(coreId);
    }
    expect(contributionIds).toContain("core/doctor/sandbox/registry-files");
    expect(contributionIds).toContain("core/doctor/gateway-services/extra");
    expect(contributionIds).toContain("core/doctor/state-integrity");
    expect(contributionIds).toContain("core/doctor/config-audit-scrub");
    expect(contributionIds).toContain("core/doctor/session-transcripts");
    expect(contributionIds).toContain("core/doctor/session-snapshots");
    expect(
      contributionChecks.find((check) => check.id === "core/doctor/session-transcripts"),
    ).toMatchObject({ defaultEnabled: false });
    expect(
      contributionChecks.find((check) => check.id === "core/doctor/session-snapshots"),
    ).toMatchObject({ defaultEnabled: false });
    expect(contributionIds).toContain("core/doctor/plugin-registry");
    expect(contributionIds).toContain("core/doctor/configured-plugin-installs");
    expect(contributionIds).toContain("core/doctor/legacy-plugin-dependencies");
    expect(contributionIds).toContain("core/doctor/stale-plugin-runtime-symlinks");
    expect(contributionIds).toContain("core/doctor/disk-space");
    expect(contributionIds).toContain("core/doctor/heartbeat-template");
    expect(contributionIds).toContain("core/doctor/whatsapp-responsiveness");
    expect(contributionIds).toContain("core/doctor/device-pairing");
    expect(contributionIds).toContain("core/doctor/channel-plugin-blockers");
    expect(contributionIds).toContain("core/doctor/channel-preview-warnings");
    expect(contributionIds).toContain("core/doctor/tool-result-cap");
    expect(contributionIds).toContain("core/doctor/systemd-linger");
    expect(contributionChecks.map((check) => check.id)).toEqual(contributionIds);
  });

  it("keeps systemd linger opt-in and reports disabled linger when selected", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const systemdLingerCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/systemd-linger",
    );
    expect(systemdLingerCheck).toMatchObject({ defaultEnabled: false });
    expect(systemdLingerCheck).toBeDefined();

    const ctx = {
      cfg: { gateway: { mode: "local" } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [systemdLingerCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    await withProcessPlatform("linux", async () => {
      await expect(
        runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/systemd-linger"] }),
      ).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/systemd-linger",
            fixHint: "Run: sudo loginctl enable-linger alice",
            target: "systemd.user.alice",
          }),
        ],
      });
    });
  });

  it("keeps selected systemd linger quiet when the gateway service is not loaded", async () => {
    mocks.gatewayServiceIsLoaded.mockResolvedValue(false);
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const systemdLingerCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/systemd-linger",
    );
    expect(systemdLingerCheck).toBeDefined();

    const ctx = {
      cfg: { gateway: { mode: "local" } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;

    await withProcessPlatform("linux", async () => {
      await expect(
        runDoctorLintChecks(ctx, {
          checks: [systemdLingerCheck!],
          onlyIds: ["core/doctor/systemd-linger"],
        }),
      ).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [],
      });
    });
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
  });

  it("keeps tool result cap opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const toolResultCapCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/tool-result-cap",
    );
    expect(toolResultCapCheck).toMatchObject({ defaultEnabled: false });
    expect(toolResultCapCheck).toBeDefined();

    const ctx = {
      cfg: {
        agents: {
          defaults: { contextLimits: { toolResultMaxChars: 16_000 } },
        },
      },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const detect = vi.fn(async () => [
      {
        checkId: "core/doctor/tool-result-cap",
        severity: "warning" as const,
        message: "Configured tool result cap overrides the model-window default.",
        path: "agents.defaults.contextLimits.toolResultMaxChars",
      },
    ]);
    // This case owns lint selection; the real cap detector is exercised below.
    const checks = [{ ...toolResultCapCheck!, detect }];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(detect).not.toHaveBeenCalled();
    await expect(
      runDoctorLintChecks(ctx, { checks, includeAllChecks: true }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/tool-result-cap",
          path: "agents.defaults.contextLimits.toolResultMaxChars",
        }),
      ],
    });
    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/tool-result-cap"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
    });
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("keeps stale plugin-runtime symlinks opt-in for structured lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const check = contributionChecks.find(
      (entry) => entry.id === "core/doctor/stale-plugin-runtime-symlinks",
    );
    expect(check).toMatchObject({ defaultEnabled: false });
    expect(check).toBeDefined();
    mocks.collectStalePluginRuntimeSymlinkHealthFindings.mockResolvedValueOnce([
      {
        checkId: "core/doctor/stale-plugin-runtime-symlinks",
        severity: "warning",
        message: "Stale plugin-runtime symlink left-pad points at plugin-runtime-deps.",
        path: "/tmp/node_modules/left-pad",
        target: "/tmp/node_modules/left-pad",
      },
    ]);

    const ctx = {
      cfg: {},
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;

    await expect(runDoctorLintChecks(ctx, { checks: [check!] })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectStalePluginRuntimeSymlinkHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, {
        checks: [check!],
        onlyIds: ["core/doctor/stale-plugin-runtime-symlinks"],
      }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/stale-plugin-runtime-symlinks",
          path: "/tmp/node_modules/left-pad",
        }),
      ],
    });
    expect(mocks.collectStalePluginRuntimeSymlinkHealthFindings).toHaveBeenCalledTimes(1);
  });

  it("reports agent findings for inherited default tool result caps", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const toolResultCapCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/tool-result-cap",
    );
    expect(toolResultCapCheck).toBeDefined();

    mocks.resolveAgentContextLimits.mockImplementation(
      (cfg: { agents?: { defaults?: { contextLimits?: unknown } } }) =>
        cfg.agents?.defaults?.contextLimits ?? {},
    );
    mocks.resolveDefaultModelForAgent.mockImplementation((...args: unknown[]) => {
      const params = args[0] as { agentId?: string };
      return params.agentId === "writer"
        ? { provider: "openai", model: "gpt-5.5" }
        : { provider: "local", model: "tiny" };
    });
    mocks.findModelCatalogEntry.mockImplementation((...args: unknown[]) => {
      const params = args[1] as { modelId?: string };
      return params.modelId === "gpt-5.5" ? { contextTokens: 200_000 } : { contextTokens: 8_000 };
    });

    const ctx = {
      cfg: {
        agents: {
          defaults: { contextLimits: { toolResultMaxChars: 16_000 } },
          list: [{ id: "writer" }],
        },
      },
      mode: "lint" as const,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    };

    await expect(
      runDoctorLintChecks(ctx, {
        checks: [toolResultCapCheck!],
        onlyIds: ["core/doctor/tool-result-cap"],
      }),
    ).resolves.toMatchObject({
      checksRun: 1,
      findings: expect.arrayContaining([
        expect.objectContaining({
          checkId: "core/doctor/tool-result-cap",
          path: "agents.defaults.contextLimits.toolResultMaxChars",
          target: "agents.list.writer",
        }),
      ]),
    });
  });

  it("keeps legacy plugin dependency lint opt-in and read-only", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openclaw-legacy-plugin-deps-lint-"));
    const stateDir = nodePath.join(tempDir, "state");
    const legacyRuntimeRoot = nodePath.join(stateDir, "plugin-runtime-deps");
    fs.mkdirSync(legacyRuntimeRoot, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const contributionChecks = await resolveDoctorContributionHealthChecks();
      const check = contributionChecks.find(
        (entry) => entry.id === "core/doctor/legacy-plugin-dependencies",
      );
      expect(check).toMatchObject({ defaultEnabled: false });
      expect(check).toBeDefined();

      const ctx = {
        cfg: {},
        mode: "lint",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      } as const;

      await expect(runDoctorLintChecks(ctx, { checks: [check!] })).resolves.toMatchObject({
        checksRun: 0,
        checksSkipped: 1,
      });
      await expect(
        runDoctorLintChecks(ctx, {
          checks: [check!],
          onlyIds: ["core/doctor/legacy-plugin-dependencies"],
        }),
      ).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/legacy-plugin-dependencies",
            severity: "warning",
            path: legacyRuntimeRoot,
          }),
        ],
      });
      expect(fs.existsSync(legacyRuntimeRoot)).toBe(true);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps state integrity opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const stateIntegrityCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/state-integrity",
    );
    expect(stateIntegrityCheck).toMatchObject({ defaultEnabled: false });
    expect(stateIntegrityCheck).toBeDefined();

    const detect = vi.fn(async () => []);

    const ctx = {
      cfg: {},
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    // Selection behavior does not need the real state-integrity filesystem scan.
    const checks = [{ ...stateIntegrityCheck!, detect }];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(detect).not.toHaveBeenCalled();
    await expect(
      runDoctorLintChecks(ctx, { checks, includeAllChecks: true }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
    });
    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/state-integrity"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
    });
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("collects memory-search notes as structured findings", async () => {
    const contribution = requireDoctorContribution("doctor:memory-search");
    const check = contribution.healthChecks[0] as HealthCheck;
    mocks.noteMemorySearchHealth.mockImplementationOnce(async (_cfg, opts) => {
      opts.noteFn(
        [
          'Memory search provider is set to "openai" but no API key was found.',
          "Semantic recall will not work without a valid API key.",
          "Fix (pick one):",
          "- Set OPENAI_API_KEY in your environment",
        ].join("\n"),
        "Memory search",
      );
    });

    const findings = await check.detect({
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      cfg: {},
    });

    expect(contribution.healthCheckIds).toEqual(["core/doctor/memory-search"]);
    expect((check as HealthCheck & { defaultEnabled?: boolean }).defaultEnabled).toBe(false);
    expect(mocks.noteMemorySearchHealth).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        includeWorkspaceMemoryHealth: false,
        skipQmdBinaryProbe: true,
        skipAuthProfileResolution: true,
        gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
        noteFn: expect.any(Function),
      }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/memory-search",
        severity: "warning",
        path: "agents.defaults.memorySearch.provider",
        message: 'Memory search provider is set to "openai" but no API key was found.',
        fixHint: expect.stringContaining("OPENAI_API_KEY"),
      }),
    ]);
  });

  it("does not report disabled memory search as a lint warning", async () => {
    const contribution = requireDoctorContribution("doctor:memory-search");
    const check = contribution.healthChecks[0] as HealthCheck;
    mocks.noteMemorySearchHealth.mockImplementationOnce(async (_cfg, opts) => {
      opts.noteFn("Memory search is explicitly disabled (enabled: false).", "Memory search");
    });

    const findings = await check.detect({
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      cfg: {},
    });

    expect(findings).toEqual([]);
  });

  it("keeps workspace suggestions opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const workspaceSuggestionsCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/workspace-suggestions",
    );
    expect(workspaceSuggestionsCheck).toMatchObject({ defaultEnabled: false });
    expect(workspaceSuggestionsCheck).toBeDefined();
    mocks.collectWorkspaceBackupTip.mockReturnValueOnce(
      "Back up your workspace before major repair work.",
    );

    const ctx = {
      cfg: {},
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [workspaceSuggestionsCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectWorkspaceBackupTip).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/workspace-suggestions"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/workspace-suggestions",
          severity: "info",
          message: "Back up your workspace before major repair work.",
        }),
      ],
    });
    expect(mocks.collectWorkspaceBackupTip).toHaveBeenCalledWith("/tmp/openclaw-workspace");
  });

  it("keeps disk space opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const diskSpaceCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/disk-space",
    );
    expect(diskSpaceCheck).toMatchObject({ defaultEnabled: false });
    expect(diskSpaceCheck).toBeDefined();

    const ctx = {
      cfg: {},
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [diskSpaceCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectDiskSpaceHealthFindings).not.toHaveBeenCalled();

    mocks.collectDiskSpaceHealthFindings.mockReturnValueOnce([
      {
        checkId: "core/doctor/disk-space",
        severity: "warning",
        message: "Low disk space: 300 MB free on the partition containing ~/.openclaw.",
        path: "/home/test/.openclaw",
        requirement: "low-free-space",
      },
    ]);

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/disk-space"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/disk-space" })],
    });
    expect(mocks.collectDiskSpaceHealthFindings).toHaveBeenCalledWith(ctx.cfg);
  });

  it("keeps WhatsApp responsiveness opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const whatsappCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/whatsapp-responsiveness",
    );
    expect(whatsappCheck).toMatchObject({ defaultEnabled: false });
    expect(whatsappCheck).toBeDefined();

    const ctx = {
      cfg: { channels: { whatsapp: { enabled: true } } },
      mode: "lint",
      allowExecSecretRefs: true,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [whatsappCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).not.toHaveBeenCalled();

    const status = {
      eventLoop: {
        degraded: true,
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        delayP99Ms: 42,
        delayMaxMs: 12_000,
        utilization: 0.3,
        cpuCoreRatio: 0.4,
      },
    };
    mocks.callGateway.mockResolvedValueOnce(status);
    mocks.collectWhatsappResponsivenessHealthFindings.mockReturnValueOnce([
      {
        checkId: "core/doctor/whatsapp-responsiveness",
        severity: "warning",
        message: "Gateway event loop is degraded while local TUI clients are running.",
        path: "channels.whatsapp",
        requirement: "local-tui-event-loop-pressure",
      },
    ]);

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/whatsapp-responsiveness"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/whatsapp-responsiveness" })],
    });
    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      config: ctx.cfg,
      deviceIdentity: null,
    });
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      status,
    });

    mocks.callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    mocks.collectWhatsappResponsivenessHealthFindings.mockReturnValueOnce([]);
    const error = vi.fn();
    await expect(
      runDoctorLintChecks(
        {
          ...ctx,
          runtime: { log: vi.fn(), error, exit: vi.fn() },
        },
        { checks, onlyIds: ["core/doctor/whatsapp-responsiveness"] },
      ),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [],
    });
    expect(error).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenLastCalledWith({
      cfg: ctx.cfg,
      status: undefined,
    });
  });

  it("skips WhatsApp responsiveness Gateway status probes for exec SecretRefs without allow-exec", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const whatsappCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/whatsapp-responsiveness",
    );
    expect(whatsappCheck).toBeDefined();
    mocks.gatewaySecretInputPathCanWin.mockReturnValue(true);
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");

    const ctx = {
      cfg: { channels: { whatsapp: { enabled: true } } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [whatsappCheck!];

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/whatsapp-responsiveness"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [],
    });
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      status: undefined,
    });
  });

  it("keeps device pairing opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const devicePairingCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/device-pairing",
    );
    expect(devicePairingCheck).toMatchObject({ defaultEnabled: false });
    expect(devicePairingCheck).toBeDefined();

    const ctx = {
      cfg: { gateway: { mode: "local" } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [devicePairingCheck!];
    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectDevicePairingHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/device-pairing"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
    });
    expect(mocks.collectDevicePairingHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      healthOk: false,
    });
  });

  it("keeps legacy cron store opt-in for default lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-cron");
    expect(contribution.healthCheckIds).toEqual([
      "core/doctor/legacy-whatsapp-crontab",
      "core/doctor/legacy-cron-store",
    ]);

    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const cronStoreCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/legacy-cron-store",
    );
    expect(cronStoreCheck).toMatchObject({ defaultEnabled: false });
    expect(cronStoreCheck).toBeDefined();

    const ctx = {
      cfg: { cron: { store: "/tmp/openclaw-cron/jobs.json" } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [cronStoreCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectLegacyCronStoreHealthFindings).not.toHaveBeenCalled();

    mocks.collectLegacyCronStoreHealthFindings.mockResolvedValueOnce([
      {
        checkId: "core/doctor/legacy-cron-store",
        severity: "warning",
        message: "Legacy JSON cron store was found.",
        path: "/tmp/openclaw-cron/jobs.json",
        requirement: "legacy-cron-store",
      },
    ]);
    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/legacy-cron-store"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/legacy-cron-store" })],
    });
    expect(mocks.collectLegacyCronStoreHealthFindings).toHaveBeenCalledWith({ cfg: ctx.cfg });
  });

  it("keeps legacy WhatsApp crontab opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const crontabCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/legacy-whatsapp-crontab",
    );
    expect(crontabCheck).toMatchObject({ defaultEnabled: false });
    expect(crontabCheck).toBeDefined();

    const ctx = {
      cfg: {},
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [crontabCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectLegacyWhatsAppCrontabHealthWarning).not.toHaveBeenCalled();

    mocks.collectLegacyWhatsAppCrontabHealthWarning.mockResolvedValueOnce(
      "Legacy WhatsApp crontab health check detected.\nRemove the stale crontab entry.",
    );

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/legacy-whatsapp-crontab"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/legacy-whatsapp-crontab",
          severity: "warning",
        }),
      ],
    });
    expect(mocks.collectLegacyWhatsAppCrontabHealthWarning).toHaveBeenCalledTimes(1);
  });

  it("keeps channel plugin blockers opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const blockerCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/channel-plugin-blockers",
    );
    expect(blockerCheck).toMatchObject({ defaultEnabled: false });
    expect(blockerCheck).toBeDefined();
    mocks.scanConfiguredChannelPluginBlockers.mockReturnValue([
      { channelId: "discord", pluginId: "discord", reason: "missing explicit enablement" },
    ]);

    const ctx = {
      cfg: { channels: { discord: { enabled: true } } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [blockerCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.scanConfiguredChannelPluginBlockers).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/channel-plugin-blockers"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/channel-plugin-blockers",
          path: "channels.discord",
          target: "discord",
        }),
      ],
    });
    expect(mocks.scanConfiguredChannelPluginBlockers).toHaveBeenCalledWith(ctx.cfg, process.env);
  });

  it("keeps channel preview warnings opt-in for default lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    expect(contribution.healthCheckIds).toEqual([
      "core/doctor/channel-plugin-blockers",
      "core/doctor/channel-preview-warnings",
    ]);
    const previewWarningsCheck = contribution.healthChecks.find(
      (check) => check.id === "core/doctor/channel-preview-warnings",
    ) as HealthCheck | undefined;
    expect(previewWarningsCheck).toMatchObject({ defaultEnabled: false });
    expect(previewWarningsCheck).toBeDefined();
    mocks.collectChannelPreviewWarningHealthFindings.mockResolvedValue([
      {
        checkId: "core/doctor/channel-preview-warnings",
        severity: "warning",
        message: "channels.matrix has a preview warning",
        path: "channels.matrix",
      },
    ]);

    const ctx = {
      cfg: { channels: { matrix: { enabled: true } } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    } as const;
    const checks = [previewWarningsCheck!];

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    expect(mocks.collectChannelPreviewWarningHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/channel-preview-warnings"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/channel-preview-warnings",
          path: "channels.matrix",
        }),
      ],
    });
    expect(mocks.collectChannelPreviewWarningHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      allowExec: false,
    });
  });

  it("forwards allow-exec secret refs into channel preview warnings", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    const previewWarningsCheck = contribution.healthChecks.find(
      (check) => check.id === "core/doctor/channel-preview-warnings",
    ) as HealthCheck | undefined;
    expect(previewWarningsCheck).toBeDefined();
    const ctx = {
      cfg: { channels: { matrix: { enabled: true } } },
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      allowExecSecretRefs: true,
    } as const;

    await previewWarningsCheck!.detect(ctx);

    expect(mocks.collectChannelPreviewWarningHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      allowExec: true,
    });
  });

  it("uses legacy run when a contribution also declares structured health", async () => {
    const legacyRun = vi.fn();
    const healthChecks = {
      description: "test legacy precedence",
      detect: vi.fn(async () => []),
    };
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-legacy-wins",
      label: "Test legacy wins",
      healthChecks,
      run: legacyRun,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(legacyRun).toHaveBeenCalledWith(ctx);
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
    expect(contribution.healthCheckIds).toEqual(["core/doctor/test-legacy-wins"]);
    expect(contribution.healthChecks).toMatchObject([
      {
        id: "core/doctor/test-legacy-wins",
        kind: "core",
        source: "doctor",
      },
    ]);
  });

  it("lets structured health own execution when legacy run is omitted", async () => {
    const healthChecks = {
      description: "test structured run",
      detect: vi.fn(async () => []),
    };
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: { updated: true },
      findings: [],
      remainingFindings: [],
      changes: ["changed from structured health"],
      warnings: ["structured warning"],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 1,
      checksValidated: 0,
    });
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-structured-run",
      label: "Test structured run",
      healthChecks,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/openclaw-workspace",
        configPath: "/tmp/fake-openclaw.json",
      }),
      {
        checks: contribution.healthChecks,
        dryRun: false,
      },
    );
    expect(ctx.cfg).toEqual({ updated: true });
    expect(ctx.cfgForPersistence).toEqual({});
    expect(ctx.runtime.error).toHaveBeenCalledWith("structured warning");
    expect(ctx.runtime.log).toHaveBeenCalledWith("changed from structured health");
  });

  it("renders findings from structured health when legacy run is omitted", async () => {
    const healthChecks = {
      description: "test structured findings",
      detect: vi.fn(async () => []),
    };
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      findings: [
        {
          checkId: "core/doctor/test-structured-findings",
          severity: "warning",
          message: "structured finding needs attention",
          path: "openclaw.json",
          line: 12,
          fixHint: "run openclaw doctor --fix",
        },
      ],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 0,
      checksValidated: 0,
    });
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-structured-findings",
      label: "Test structured findings",
      healthChecks,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.runtime.log).toHaveBeenCalledWith(
      "[warning] core/doctor/test-structured-findings openclaw.json:12 - structured finding needs attention",
    );
    expect(ctx.runtime.log).toHaveBeenCalledWith("  fix: run openclaw doctor --fix");
  });

  it("runs structured-only contributions in dry-run mode when doctor is not repairing", async () => {
    const healthChecks = {
      description: "test structured dry-run",
      detect: vi.fn(async () => []),
    };
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-structured-dry-run",
      label: "Test structured dry-run",
      healthChecks,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/openclaw-workspace" }),
      {
        checks: contribution.healthChecks,
        dryRun: true,
      },
    );
  });

  it("requires explicit health check ids for multi-check contributions", () => {
    expect(() =>
      createDoctorHealthContribution({
        id: "doctor:test-multiple-checks",
        label: "Test multiple checks",
        healthChecks: [
          {
            description: "first",
            detect: vi.fn(async () => []),
          },
          {
            description: "second",
            detect: vi.fn(async () => []),
          },
        ],
      }),
    ).toThrow("must specify health check ids when it declares multiple healthChecks");
  });

  it("repairs browser residue before browser readiness notes", async () => {
    const calls: string[] = [];
    mocks.runDoctorHealthRepairs.mockImplementation(async () => {
      calls.push("repair");
      return {
        config: {},
        findings: [],
        remainingFindings: [],
        changes: [],
        warnings: [],
        diffs: [],
        effects: [],
        checksRun: 1,
        checksRepaired: 1,
        checksValidated: 0,
      };
    });
    mocks.noteChromeMcpBrowserReadiness.mockImplementation(async () => {
      calls.push("note");
    });
    const contribution = requireDoctorContribution("doctor:browser");
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(calls).toEqual(["repair", "note"]);
  });

  it("runs structured repairs before legacy skill repairs and config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:structured-health-repairs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:structured-health-repairs")).toBeLessThan(
      ids.indexOf("doctor:skills"),
    );
    expect(ids.indexOf("doctor:structured-health-repairs")).toBeLessThan(
      ids.indexOf("doctor:write-config"),
    );
  });

  it("keeps core-kind repairs out of the extension repair pass", async () => {
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(expect.any(Object), {
      checks: [{ id: "plugin/example/unrelated", kind: "plugin" }],
    });
  });

  it("rejects extension repairs that claim reserved core doctor ids", async () => {
    mocks.listHealthChecks.mockReturnValue([
      { id: "plugin/example/unrelated", kind: "plugin" },
      { id: "core/doctor/shell-completion", kind: "plugin" },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await expect(contribution.run(ctx)).rejects.toThrow(
      "health check already registered: core/doctor/shell-completion",
    );
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
  });

  it("rejects registered core-kind repairs that claim reserved core doctor ids", async () => {
    mocks.listHealthChecks.mockReturnValue([
      { id: "plugin/example/unrelated", kind: "plugin" },
      { id: "core/doctor/shell-completion", kind: "core" },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await expect(contribution.run(ctx)).rejects.toThrow(
      "health check already registered: core/doctor/shell-completion",
    );
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
  });

  it("reports runtime tool schema blockers during normal doctor runs", async () => {
    const contribution = requireDoctorContribution("doctor:runtime-tool-schemas");
    mocks.getHealthCheck.mockReturnValue({
      id: "core/doctor/runtime-tool-schemas",
      detect: vi.fn(async () => [
        {
          checkId: "core/doctor/runtime-tool-schemas",
          severity: "error",
          message:
            "Tool fuzzplugin_move_angles from plugin fuzzplugin has an unsupported input schema for runtime projection.",
          path: "plugins.entries.fuzzplugin",
          target: "fuzzplugin_move_angles",
          requirement: 'fuzzplugin_move_angles.parameters.type must be "object"',
          fixHint:
            "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.",
        },
      ]),
    });
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.healthOk).toBe(false);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Tool fuzzplugin_move_angles from plugin fuzzplugin"),
      "Doctor warnings",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining('issue: fuzzplugin_move_angles.parameters.type must be "object"'),
      "Doctor warnings",
    );
  });

  it("reports provider catalog projection blockers during normal doctor runs", async () => {
    const contribution = requireDoctorContribution("doctor:provider-catalog-projection");
    mocks.getHealthCheck.mockReturnValue({
      id: "core/doctor/provider-catalog-projection",
      detect: vi.fn(async () => [
        {
          checkId: "core/doctor/provider-catalog-projection",
          severity: "error",
          message:
            "Provider catalog mockplugin cannot be projected into the unified text model catalog.",
          path: "plugins.entries.mockplugin",
          target: "mockplugin",
          requirement: "provider catalog entry read failed",
          fixHint:
            "Fix the plugin provider catalog hook or disable the plugin, then rerun doctor before relying on model discovery.",
        },
      ]),
    });
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.healthOk).toBe(false);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Provider catalog mockplugin cannot be projected"),
      "Doctor warnings",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("issue: provider catalog entry read failed"),
      "Doctor warnings",
    );
  });

  it.each([false, true])(
    "reports default-account routing warnings during doctor runs (repair=%s)",
    async (shouldRepair) => {
      const contribution = requireDoctorContribution("doctor:default-account-routing");
      mocks.runDoctorHealthRepairs.mockImplementation(async (ctx, options) => {
        const findings = await options.checks[0]!.detect(ctx);
        return {
          config: ctx.cfg,
          findings,
          remainingFindings: findings,
          changes: [],
          warnings: [],
          diffs: [],
          effects: [],
          checksRun: 1,
          checksRepaired: 0,
          checksValidated: 1,
        };
      });
      const ctx = {
        cfg: {
          channels: {
            telegram: {
              accounts: {
                alerts: {},
                work: {},
              },
            },
          },
          bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
        } as unknown as OpenClawConfig,
        configResult: { cfg: {} },
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(shouldRepair),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        cfgForPersistence: {},
        configPath: "/tmp/fake-openclaw.json",
        env: {},
      } as unknown as Parameters<(typeof contribution)["run"]>[0];

      await contribution.run(ctx);

      expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "fix", dryRun: !shouldRepair }),
        expect.objectContaining({
          checks: contribution.healthChecks,
          dryRun: !shouldRepair,
        }),
      );
      expect(ctx.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("accounts.default is missing and no valid account-scoped binding"),
      );
      expect(ctx.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("multiple accounts are configured but no explicit default is set"),
      );
    },
  );

  it("skips doctor config writes under legacy update parents", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      }),
    ).toBe(true);
  });

  it("keeps doctor writes outside legacy update writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {},
      }),
    ).toBe(false);
  });

  it("keeps current update parents writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
      }),
    ).toBe(false);
  });

  it("treats falsey update env values as normal writes", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
        },
      }),
    ).toBe(false);
  });

  describe("write-config lint findings", () => {
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");
    const check = writeConfigContribution.healthChecks[0] as HealthCheck & {
      defaultEnabled?: boolean;
    };

    it("keeps write-config lint opt-in for structured findings", async () => {
      expect(writeConfigContribution.healthCheckIds).toEqual(["core/doctor/write-config"]);
      expect(check.defaultEnabled).toBe(false);

      const ctx = {
        cfg: {},
        mode: "lint" as const,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        configPath: "/tmp/fake-openclaw.json",
      };

      await expect(runDoctorLintChecks(ctx, { checks: [check] })).resolves.toMatchObject({
        checksRun: 0,
        checksSkipped: 1,
        findings: [],
      });
    });

    it("reports Nix immutable config mode when selected", async () => {
      vi.stubEnv("OPENCLAW_NIX_MODE", "1");

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath: "/tmp/fake-openclaw.json",
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/fake-openclaw.json",
            requirement: "mutable-config-write-path",
          }),
        ],
      });
    });

    it("skips a read-only existing config when its directory is writable", async () => {
      const configPath = "/tmp/openclaw-home/openclaw.json";
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === configPath);
      vi.spyOn(fs, "statSync").mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath,
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        findings: [],
      });
      expect(accessSpy).toHaveBeenCalledWith(
        "/tmp/openclaw-home",
        fs.constants.W_OK | fs.constants.X_OK,
      );
    });

    it("reports an unwritable config directory for an existing config", async () => {
      const configPath = "/tmp/openclaw-home/openclaw.json";
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === configPath);
      vi.spyOn(fs, "statSync").mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);
      vi.spyOn(fs, "accessSync").mockImplementation(() => {
        throw new Error("EACCES");
      });

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath,
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/openclaw-home",
            target: configPath,
            requirement: "writable-config-directory",
          }),
        ],
      });
    });

    it("skips a missing config directory when an existing ancestor is writable", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === "/tmp");
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath: "/tmp/openclaw-home/openclaw.json",
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        findings: [],
      });
      expect(accessSpy).toHaveBeenCalledWith("/tmp", fs.constants.W_OK | fs.constants.X_OK);
    });

    it("reports an unwritable existing parent when the config file is missing", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === "/tmp");
      vi.spyOn(fs, "accessSync").mockImplementation(() => {
        throw new Error("EACCES");
      });

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath: "/tmp/openclaw-home/openclaw.json",
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp",
            target: "/tmp/openclaw-home",
            requirement: "writable-config-directory",
          }),
        ],
      });
    });

    it("reports an existing parent without search permission", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === "/tmp");
      vi.spyOn(fs, "accessSync").mockImplementation((_path, mode) => {
        if (mode === (fs.constants.W_OK | fs.constants.X_OK)) {
          throw new Error("EACCES");
        }
      });

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath: "/tmp/openclaw-home/openclaw.json",
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp",
            target: "/tmp/openclaw-home",
            requirement: "writable-config-directory",
          }),
        ],
      });
    });

    it("reports an existing file that blocks the config directory path", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === "/tmp/openclaw-home");
      vi.spyOn(fs, "statSync").mockReturnValue({
        isDirectory: () => false,
      } as fs.Stats);
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath: "/tmp/openclaw-home/openclaw.json",
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/openclaw-home",
            target: "/tmp/openclaw-home",
            requirement: "config-directory-path",
          }),
        ],
      });
      expect(accessSpy).not.toHaveBeenCalled();
    });

    it("reports a dangling symlink that blocks the config directory path", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === "/tmp");
      vi.spyOn(fs, "lstatSync").mockImplementation((path) => {
        if (path === "/tmp/openclaw-home") {
          return { isDirectory: () => false } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      await expect(
        runDoctorLintChecks(
          {
            cfg: {},
            mode: "lint" as const,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            configPath: "/tmp/openclaw-home/openclaw.json",
          },
          { checks: [check], onlyIds: ["core/doctor/write-config"] },
        ),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/openclaw-home",
            target: "/tmp/openclaw-home",
            requirement: "config-directory-path",
          }),
        ],
      });
      expect(accessSpy).not.toHaveBeenCalled();
    });
  });

  it("preserves gateway service config repairs for later doctor writes", async () => {
    const gatewayServicesContribution = requireDoctorContribution("doctor:gateway-services");
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");
    const originalCfg = { gateway: {} };
    const repairedCfg = {
      gateway: {
        auth: {
          mode: "token",
          token: "recovered-token",
        },
      },
    };
    mocks.maybeRepairGatewayServiceConfig.mockResolvedValueOnce(repairedCfg);

    const ctx = {
      cfg: originalCfg,
      cfgForPersistence: originalCfg,
      configResult: {
        cfg: originalCfg,
        preservedLegacyRootKeys: ["defaultModel"],
        shouldWriteConfig: true,
        skipPluginValidationOnWrite: true,
      },
      configPath: "/tmp/fake-openclaw.json",
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
    } as unknown as DoctorContributionRunContext;

    await gatewayServicesContribution.run(ctx);
    await writeConfigContribution.run(ctx);

    expect(ctx.cfg).toBe(repairedCfg);
    expect(mocks.maybeRepairGatewayServiceConfig).toHaveBeenCalledWith(
      originalCfg,
      "local",
      ctx.runtime,
      ctx.prompter,
      expect.objectContaining({
        allowConfigSizeDrop: true,
        preservedLegacyRootKeys: ["defaultModel"],
        skipPluginValidation: true,
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: repairedCfg,
      }),
    );
  });

  describe("config size drops during update", () => {
    beforeEach(() => {
      mocks.replaceConfigFile.mockReset();
      mocks.replaceConfigFile.mockResolvedValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
    });

    function buildWriteConfigCtx(env: Record<string, string | undefined>) {
      const cfg = { gateway: { mode: "local" } };
      return {
        cfg,
        cfgForPersistence: { gateway: { mode: "remote" } },
        configResult: {
          cfg,
          shouldWriteConfig: true,
          skipPluginValidationOnWrite: false,
        },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env,
      } as DoctorContributionRunContext;
    }

    const writeConfigContribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:write-config",
    )!;

    it("allows config size drops when OPENCLAW_UPDATE_IN_PROGRESS=1", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            allowConfigSizeDrop: true,
          }),
        }),
      );
    });

    it("skips plugin schema validation during update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            skipPluginValidation: true,
          }),
        }),
      );
    });

    it("preserves source config version for legacy parent writable update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            lastTouchedVersionOverride: "2026.5.16-beta.4",
          }),
        }),
      );
    });

    it("does not preserve source config version for explicit deferral update doctors", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.not.objectContaining({
            lastTouchedVersionOverride: expect.anything(),
          }),
        }),
      );
    });

    it("keeps plugin schema validation for ordinary doctor writes", async () => {
      const ctx = buildWriteConfigCtx({});
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            skipPluginValidation: false,
          }),
        }),
      );
    });

    it("points update-time config rewrites at the pre-update backup", async () => {
      vi.mocked(fs.existsSync).mockImplementation((value) => String(value).endsWith(".pre-update"));
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });

      await writeConfigContribution.run(ctx);

      expect(ctx.runtime.log).toHaveBeenCalledWith(
        "Update changed config; pre-update backup: /tmp/fake-openclaw.json.pre-update",
      );
    });

    it("skips plugin schema validation for final validation during update doctor runs", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run({
        cfg: {},
        cfgForPersistence: {},
        configResult: { cfg: {} },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
        },
      } as DoctorContributionRunContext);

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: true,
      });
    });

    it("keeps plugin schema validation for ordinary doctor final validation", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run({
        cfg: {},
        cfgForPersistence: {},
        configResult: { cfg: {} },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env: {},
      } as DoctorContributionRunContext);

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: false,
      });
    });

    it("allows allowConfigSizeDrop when not in update", async () => {
      const ctx = buildWriteConfigCtx({});
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            allowConfigSizeDrop: true,
          }),
        }),
      );
    });
  });
});
