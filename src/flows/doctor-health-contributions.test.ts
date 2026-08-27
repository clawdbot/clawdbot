// Doctor health contribution tests cover plugin-provided health checks.
import fs from "node:fs";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LEGACY_SECRETREF_ENV_MARKER_PREFIX } from "../config/types.secrets.js";
import { migrateLegacySecretRefEnvMarkers } from "../secrets/legacy-secretref-env-marker.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { resolveDoctorContributionHealthChecks } from "./doctor-health-contributions.js";
import {
  createDoctorConfigFixture,
  createDoctorHealthContribution,
  createDoctorHealthFlowContext,
  createDoctorLintContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

// This suite's SecretRef migration assertion uses a core model credential. Registry owner suites
// cover plugin-derived targets, so avoid scanning every bundled plugin for this core-only fixture.
vi.mock("../secrets/target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/target-registry-data.js")>();
  return {
    ...actual,
    getSecretTargetRegistry: actual.getCoreSecretTargetRegistry,
  };
});

const mocks = vi.hoisted(() => ({
  isDefaultInstallIdentity: vi.fn(() => true),
  isContainerEnvironment: vi.fn(() => false),
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  registerBundledHealthChecks: vi.fn(),
  runDoctorHealthRepairs: vi.fn(),
  maybeMigrateAuthProfileJsonStoresToSqlite: vi.fn().mockResolvedValue(undefined),
  maybeMigrateLegacyPluginModelCatalogs: vi.fn().mockResolvedValue({
    detected: 0,
    migrated: 0,
    warnings: [],
  }),
  maybeMigrateModelCatalogCredentials: vi.fn(async () => ({
    detected: 0,
    migrated: 0,
    warnings: [],
  })),
  maybeRepairGatewayDaemon: vi.fn().mockResolvedValue(undefined),
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (cfg: unknown) => ({
    config: cfg,
    retiredProfileCleanupPlans: [] as Array<{
      agentDir?: string;
      profileIds: readonly string[];
    }>,
  })),
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn().mockResolvedValue(undefined),
  removeAuthProfilesAcrossOwnerStores: vi.fn(async () => true),
  collectAuthProfileHealthFindings: vi.fn(async () => []),
  noteAuthProfileHealth: vi.fn().mockResolvedValue(undefined),
  noteLegacyCodexProviderOverride: vi.fn(),
  noteSharedAuthStoreStatus: vi.fn(),
  noteMemorySearchHealth: vi.fn().mockResolvedValue(undefined),
  noteWebFetchProxyDiagnostic: vi.fn().mockResolvedValue(undefined),
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
  maybeResolveDuelingSystemdGatewayScopes: vi.fn().mockResolvedValue(undefined),
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
  maybeRepairOwnedChromeExtensionNativeHosts: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  listAgentIds: vi.fn<(_cfg: OpenClawConfig) => string[]>(() => ["default"]),
  listAgentEntries: vi.fn(() => [{ id: "default" }]),
  tryResolveSoleAgentId: vi.fn<(_cfg: OpenClawConfig) => string | undefined>(() => "default"),
  resolveAgentWorkspaceDir: vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(
    () => "/tmp/openclaw-workspace",
  ),
  tryResolveConfiguredAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  tryResolveSystemAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentId: vi.fn<(_cfg: OpenClawConfig) => string>(() => "default"),
  resolveAgentContextLimits: vi.fn(
    (cfg: { agents?: { defaults?: { contextLimits?: unknown } } }) =>
      cfg.agents?.defaults?.contextLimits ?? {},
  ),
  note: vi.fn(),
  collectActiveToolSchemaProjectionWarnings: vi.fn(),
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
  collectWorkspaceBackupTip: vi.fn<(workspaceDir: string) => string | undefined>(() => undefined),
  shouldSuggestMemorySystem: vi.fn<(workspaceDir: string) => Promise<boolean>>(async () => false),
  collectDiskSpaceHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  collectHeartbeatCadenceMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatCadenceToCron: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  collectHeartbeatScratchMigrationFindings: vi.fn(async () => [] as unknown[]),
  collectToolsMdMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatFilesToScratch: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  maybeMigrateToolsMd: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  collectHeartbeatTaskMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatTasksToCron: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  collectWhatsappResponsivenessHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  noteWhatsappResponsivenessHealth: vi.fn().mockResolvedValue(undefined),
  collectDevicePairingHealthFindings: vi.fn(async () => []),
  collectLegacyCronStoreHealthFindings: vi.fn(async (): Promise<readonly HealthFinding[]> => []),
  collectLegacyWhatsAppCrontabHealthWarning: vi.fn(
    async (): Promise<string | undefined> => undefined,
  ),
  maybeRepairLegacyCronStore: vi.fn().mockResolvedValue(undefined),
  repairCronCodexModelRefsAfterConfigWrite: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
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
  collectBundledChannelPackageStateLoadFailures: vi.fn(() => [] as unknown[]),
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
  findInstalledSystemdGatewayScope: vi.fn<
    (typeof import("../daemon/systemd.js"))["findInstalledSystemdGatewayScope"]
  >(async () => ({
    scope: "user",
    unitName: "openclaw-gateway.service",
    unitPath: "/home/alice/.config/systemd/user/openclaw-gateway.service",
  })),
  isSystemdUserServiceAvailable: vi.fn(async () => true),
  readSystemdUserLingerStatus: vi.fn(
    async (_params: {
      env: Record<string, string | undefined>;
      user?: string;
    }): Promise<{ user: string; linger: "yes" | "no" } | null> => ({
      user: "alice",
      linger: "no",
    }),
  ),
  resolveSystemdUserServiceAccount: vi.fn(() => "alice" as string | null),
  gatewayServiceIsLoaded: vi.fn(async () => true),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return { ...actual, isDefaultInstallIdentity: mocks.isDefaultInstallIdentity };
});

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
  maybeResolveDuelingSystemdGatewayScopes: mocks.maybeResolveDuelingSystemdGatewayScopes,
}));

vi.mock("../commands/doctor-auth-flat-profiles.js", () => ({
  maybeMigrateAuthProfileJsonStoresToSqlite: mocks.maybeMigrateAuthProfileJsonStoresToSqlite,
}));

vi.mock("../commands/doctor-plugin-model-catalog.js", () => ({
  maybeMigrateLegacyPluginModelCatalogs: mocks.maybeMigrateLegacyPluginModelCatalogs,
}));

vi.mock("../commands/doctor-model-catalog-credentials.js", () => ({
  maybeMigrateModelCatalogCredentials: mocks.maybeMigrateModelCatalogCredentials,
}));

vi.mock("../commands/doctor-gateway-daemon-flow.js", () => ({
  maybeRepairGatewayDaemon: mocks.maybeRepairGatewayDaemon,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    readGatewayServiceState: async () => ({
      installed: true,
      loadState: {
        status: (await mocks.gatewayServiceIsLoaded()) ? "loaded" : "not-loaded",
      },
      running: false,
      env: {},
      command: null,
      runtime: { status: "stopped" },
    }),
    resolveGatewayService: mocks.resolveGatewayService,
  };
});

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    findInstalledSystemdGatewayScope: mocks.findInstalledSystemdGatewayScope,
    isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
    readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
    resolveSystemdUserServiceAccount: mocks.resolveSystemdUserServiceAccount,
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

vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

vi.mock("../commands/doctor-auth.js", () => ({
  collectAuthProfileHealthFindings: mocks.collectAuthProfileHealthFindings,
  noteAuthProfileHealth: mocks.noteAuthProfileHealth,
  noteLegacyCodexProviderOverride: mocks.noteLegacyCodexProviderOverride,
  noteSharedAuthStoreStatus: mocks.noteSharedAuthStoreStatus,
}));

vi.mock("../commands/doctor-memory-search.js", () => ({
  maybeRepairMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemorySearchHealth: mocks.noteMemorySearchHealth,
}));

vi.mock("../commands/doctor-web-fetch-proxy.js", () => ({
  noteWebFetchProxyDiagnostic: mocks.noteWebFetchProxyDiagnostic,
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
    readGatewaySecretInputValue: (
      ...args: Parameters<typeof actual.readGatewaySecretInputValue>
    ) =>
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
  };
});

vi.mock("../commands/doctor-browser.js", () => ({
  noteChromeMcpBrowserReadiness: mocks.noteChromeMcpBrowserReadiness,
  detectLegacyClawdBrowserProfileResidue: mocks.detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue: mocks.maybeArchiveLegacyClawdBrowserProfileResidue,
  maybeRepairOwnedChromeExtensionNativeHosts: mocks.maybeRepairOwnedChromeExtensionNativeHosts,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  listAgentEntries: mocks.listAgentEntries,
  tryResolveSoleAgentId: mocks.tryResolveSoleAgentId,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  tryResolveConfiguredAgentWorkspaceDir: mocks.tryResolveConfiguredAgentWorkspaceDir,
  tryResolveSystemAgentWorkspaceDir: mocks.tryResolveSystemAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentContextLimits: mocks.resolveAgentContextLimits,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../commands/doctor/shared/active-tool-schema-warnings.js", () => ({
  collectActiveToolSchemaProjectionWarnings: mocks.collectActiveToolSchemaProjectionWarnings,
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelCatalogEntry: mocks.findModelCatalogEntry,
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: mocks.loadModelCatalog,
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

vi.mock("../commands/doctor-heartbeat-cadence-migration.js", () => ({
  collectHeartbeatCadenceMigrationFindings: mocks.collectHeartbeatCadenceMigrationFindings,
  maybeMigrateHeartbeatCadenceToCron: mocks.maybeMigrateHeartbeatCadenceToCron,
}));

vi.mock("../commands/doctor-heartbeat-scratch-migration.js", () => ({
  collectHeartbeatScratchMigrationFindings: mocks.collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch: mocks.maybeMigrateHeartbeatFilesToScratch,
}));

vi.mock("../commands/doctor-tools-md-migration.js", () => ({
  collectToolsMdMigrationFindings: mocks.collectToolsMdMigrationFindings,
  maybeMigrateToolsMd: mocks.maybeMigrateToolsMd,
}));

vi.mock("../commands/doctor-heartbeat-task-migration.js", () => ({
  collectHeartbeatTaskMigrationFindings: mocks.collectHeartbeatTaskMigrationFindings,
  maybeMigrateHeartbeatTasksToCron: mocks.maybeMigrateHeartbeatTasksToCron,
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

vi.mock("../commands/doctor/cron/legacy-repair.js", () => ({
  repairCronCodexModelRefsAfterConfigWrite: mocks.repairCronCodexModelRefsAfterConfigWrite,
}));

vi.mock("../commands/doctor/shared/channel-plugin-blockers.js", () => ({
  scanConfiguredChannelPluginBlockers: mocks.scanConfiguredChannelPluginBlockers,
  channelPluginBlockerHitToHealthFinding: mocks.channelPluginBlockerHitToHealthFinding,
}));

vi.mock("../channels/plugins/package-state-probes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/package-state-probes.js")>()),
  collectBundledChannelPackageStateLoadFailures:
    mocks.collectBundledChannelPackageStateLoadFailures,
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

function createDoctorContext({
  shouldRepair = false,
  ...overrides
}: Parameters<typeof createDoctorHealthFlowContext>[0] & { shouldRepair?: boolean } = {}) {
  return createDoctorHealthFlowContext({
    configPath: "/tmp/fake-openclaw.json",
    prompter: buildDoctorPrompter(shouldRepair),
    ...overrides,
  });
}

function createDoctorLintFixture(
  cfg: OpenClawConfig | Record<string, unknown> = {},
  overrides: Omit<Parameters<typeof createDoctorLintContext>[0], "cfg"> = {},
) {
  return createDoctorLintContext({
    cfg: cfg as OpenClawConfig,
    mode: "lint",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    ...overrides,
  });
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
    mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.registerBundledHealthChecks.mockReset();
    mocks.runDoctorHealthRepairs.mockReset();
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockClear().mockResolvedValue(undefined);
    mocks.maybeMigrateLegacyPluginModelCatalogs.mockClear().mockResolvedValue({
      detected: 0,
      migrated: 0,
      warnings: [],
    });
    mocks.maybeRepairGatewayDaemon.mockClear().mockResolvedValue(undefined);
    mocks.maybeRepairLegacyOAuthProfileIds.mockClear().mockImplementation(async (cfg: unknown) => ({
      config: cfg,
      retiredProfileCleanupPlans: [],
    }));
    mocks.collectLegacyPluginManifestContractMigrations.mockReset().mockReturnValue([]);
    mocks.legacyPluginManifestContractMigrationToHealthFinding.mockClear();
    mocks.maybeRepairLegacyPluginManifestContracts.mockClear().mockResolvedValue(undefined);
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockClear().mockResolvedValue(undefined);
    mocks.removeAuthProfilesAcrossOwnerStores.mockClear().mockResolvedValue(true);
    mocks.collectAuthProfileHealthFindings.mockClear().mockResolvedValue([]);
    mocks.noteAuthProfileHealth.mockClear().mockResolvedValue(undefined);
    mocks.noteLegacyCodexProviderOverride.mockClear();
    mocks.noteSharedAuthStoreStatus.mockClear();
    mocks.noteMemorySearchHealth.mockClear().mockResolvedValue(undefined);
    mocks.noteWebFetchProxyDiagnostic.mockClear().mockResolvedValue(undefined);
    mocks.buildGatewayConnectionDetails.mockClear().mockReturnValue({ message: "gateway details" });
    mocks.callGateway.mockReset().mockResolvedValue({});
    mocks.resolveSecretInputRef.mockClear();
    mocks.resolveGatewayAuth.mockClear().mockReturnValue({ mode: "token", token: undefined });
    mocks.resolveGatewayAuthToken.mockClear().mockResolvedValue({
      source: "unavailable",
      unresolvedRefReason: "exec provider failed",
    });
    mocks.getSkippedExecRefStaticError.mockClear().mockReturnValue(undefined);
    mocks.maybeRepairGatewayServiceConfig.mockClear().mockResolvedValue(undefined);
    mocks.maybeScanExtraGatewayServices.mockClear().mockResolvedValue(undefined);
    mocks.maybeResolveDuelingSystemdGatewayScopes.mockClear();
    mocks.noteMacLaunchAgentOverrides.mockClear();
    mocks.noteMacLaunchctlGatewayEnvOverrides.mockClear();
    mocks.noteMacStaleOpenClawUpdateLaunchdJobs.mockClear();
    mocks.gatewaySecretInputPathCanWin.mockClear().mockReset();
    mocks.readGatewaySecretInputValue.mockClear().mockReset();
    mocks.checkGatewayHealth.mockClear().mockResolvedValue({
      authenticated: true,
      healthOk: true,
      status: { ok: true },
    });
    mocks.probeGatewayMemoryStatus.mockClear().mockResolvedValue({
      checked: true,
      ready: true,
      skipped: false,
    });
    // Real repairs echo the input config unless they change it; mirror that so
    // config-identity assertions downstream of a repair stay realistic.
    mocks.runDoctorHealthRepairs.mockImplementation(async (input: { cfg?: unknown }) => ({
      config: input.cfg ?? {},
      findings: [],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 0,
      checksRepaired: 0,
      checksValidated: 0,
    }));
    mocks.listHealthChecks.mockReset().mockReturnValue([
      { id: "core/example/internal", kind: "core" },
      { id: "plugin/example/unrelated", kind: "plugin" },
    ]);
    mocks.noteChromeMcpBrowserReadiness.mockReset().mockResolvedValue(undefined);
    mocks.detectLegacyStateMigrations
      .mockReset()
      .mockResolvedValue({ preview: [], warnings: [], notices: [] });
    mocks.runLegacyStateMigrations.mockReset().mockResolvedValue({ changes: [], warnings: [] });
    mocks.detectLegacyClawdBrowserProfileResidue.mockReset().mockReturnValue(null);
    mocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockReset().mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw-workspace");
    mocks.tryResolveConfiguredAgentWorkspaceDir
      .mockReset()
      .mockReturnValue("/tmp/openclaw-workspace");
    mocks.tryResolveSystemAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw-workspace");
    mocks.listAgentIds.mockReset().mockReturnValue(["default"]);
    mocks.listAgentEntries.mockReset().mockReturnValue([{ id: "default" }]);
    mocks.tryResolveSoleAgentId.mockReset().mockReturnValue("default");
    mocks.resolveDefaultAgentId.mockReset().mockReturnValue("default");
    mocks.resolveAgentContextLimits
      .mockReset()
      .mockImplementation(
        (cfg: { agents?: { defaults?: { contextLimits?: unknown } } }) =>
          cfg.agents?.defaults?.contextLimits ?? {},
      );
    mocks.note.mockReset();
    mocks.collectActiveToolSchemaProjectionWarnings.mockReset().mockResolvedValue([]);
    mocks.loadModelCatalog.mockReset().mockResolvedValue([]);
    mocks.findModelCatalogEntry.mockReset().mockReturnValue({ contextTokens: 200_000 });
    mocks.getModelRefStatus.mockReset().mockReturnValue({
      allowed: true,
      inCatalog: true,
      key: "openai/gpt-5.5",
    });
    mocks.resolveConfiguredModelRef
      .mockReset()
      .mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.resolveDefaultModelForAgent
      .mockReset()
      .mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.resolveHooksGmailModel
      .mockReset()
      .mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.modelKey
      .mockReset()
      .mockImplementation((provider: string, model: string) => `${provider}/${model}`);
    mocks.readConfigFileSnapshot.mockReset().mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.checkGatewayHealth.mockReset();
    mocks.probeGatewayMemoryStatus.mockReset();
    mocks.gatherDaemonStatus.mockReset().mockResolvedValue({});
    mocks.noteWorkspaceStatus.mockReset();
    mocks.resolveGatewayService
      .mockReset()
      .mockReturnValue({ isLoaded: mocks.gatewayServiceIsLoaded });
    mocks.gatewayServiceIsLoaded.mockReset().mockResolvedValue(true);
    mocks.collectWorkspaceStatusHealthFindings.mockReset().mockResolvedValue([]);
    mocks.collectDiskSpaceHealthFindings.mockReset().mockReturnValue([]);
    mocks.collectHeartbeatCadenceMigrationFindings.mockReset().mockResolvedValue([]);
    mocks.maybeMigrateHeartbeatCadenceToCron
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    mocks.collectHeartbeatScratchMigrationFindings.mockReset().mockResolvedValue([]);
    mocks.maybeMigrateHeartbeatFilesToScratch
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    mocks.collectToolsMdMigrationFindings.mockReset().mockResolvedValue([]);
    mocks.maybeMigrateToolsMd.mockReset().mockResolvedValue({ changes: [], warnings: [] });
    mocks.collectHeartbeatTaskMigrationFindings.mockReset().mockResolvedValue([]);
    mocks.maybeMigrateHeartbeatTasksToCron
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    mocks.collectWhatsappResponsivenessHealthFindings.mockReset().mockReturnValue([]);
    mocks.noteWhatsappResponsivenessHealth.mockReset().mockResolvedValue(undefined);
    mocks.collectDevicePairingHealthFindings.mockReset().mockResolvedValue([]);
    mocks.collectLegacyCronStoreHealthFindings.mockReset().mockResolvedValue([]);
    mocks.collectLegacyWhatsAppCrontabHealthWarning.mockReset().mockResolvedValue(undefined);
    mocks.maybeRepairLegacyCronStore.mockReset().mockResolvedValue(undefined);
    mocks.repairCronCodexModelRefsAfterConfigWrite.mockReset().mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.noteLegacyWhatsAppCrontabHealthCheck.mockReset().mockResolvedValue(undefined);
    mocks.scanConfiguredChannelPluginBlockers.mockReset().mockReturnValue([]);
    mocks.channelPluginBlockerHitToHealthFinding.mockClear();
    mocks.collectBundledChannelPackageStateLoadFailures.mockReset().mockReturnValue([]);
    mocks.collectStalePluginRuntimeSymlinkHealthFindings.mockReset().mockResolvedValue([]);
    mocks.collectChannelPreviewWarningHealthFindings.mockReset().mockResolvedValue([]);
    mocks.findInstalledSystemdGatewayScope.mockReset().mockResolvedValue({
      scope: "user",
      unitName: "openclaw-gateway.service",
      unitPath: "/home/alice/.config/systemd/user/openclaw-gateway.service",
    });
    mocks.isSystemdUserServiceAvailable.mockReset().mockResolvedValue(true);
    mocks.readSystemdUserLingerStatus
      .mockReset()
      .mockResolvedValue({ user: "alice", linger: "no" });
    mocks.resolveSystemdUserServiceAccount.mockReset().mockReturnValue("alice");
    mocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
    mocks.applyWizardMetadata.mockReset().mockImplementation((cfg: unknown) => cfg);
    mocks.maybeRepairGatewayServiceConfig
      .mockReset()
      .mockImplementation(async (cfg: unknown) => cfg);
    mocks.maybeScanExtraGatewayServices.mockReset().mockResolvedValue(undefined);
    mocks.noteMacLaunchAgentOverrides.mockReset().mockResolvedValue(undefined);
    mocks.noteMacLaunchctlGatewayEnvOverrides.mockReset().mockResolvedValue(undefined);
    mocks.noteMacStaleOpenClawUpdateLaunchdJobs.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("continues after an advisory doctor contribution throws", async () => {
    const laterRun = vi.fn(async () => undefined);
    const contributions = [
      createDoctorHealthContribution({
        id: "doctor:test-failure",
        label: "Test failure",
        run: async () => {
          throw new Error("media migration required");
        },
      }),
      createDoctorHealthContribution({
        id: "doctor:test-later",
        label: "Test later",
        run: laterRun,
      }),
    ];
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      shouldRepair: true,
      env: {},
    });

    await runDoctorHealthContributionList(ctx, contributions);

    expect(laterRun).toHaveBeenCalledOnce();
    expect(mocks.note).toHaveBeenCalledWith(
      "doctor:test-failure run failed: media migration required",
      "Doctor warnings",
    );
  });

  it("rejects a failed initial config write before later work runs", async () => {
    const laterRun = vi.fn(async () => undefined);
    const cfg = { gateway: { mode: "invalid" } } as unknown as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("Config validation failed"));

    await expect(
      runDoctorHealthContributionList(ctx, [
        requireDoctorContribution("doctor:write-config-migrations"),
        createDoctorHealthContribution({
          id: "doctor:test-later",
          label: "Test later",
          run: laterRun,
        }),
      ]),
    ).rejects.toThrow("Config validation failed");

    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
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
    const ctx = createDoctorLintFixture({ plugins: { load: { paths: ["/tmp/openclaw-plugin"] } } });

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

  it("invalidates retained plugin metadata after rewriting a legacy manifest", async () => {
    mocks.maybeRepairLegacyPluginManifestContracts.mockResolvedValueOnce(true);
    const invalidatePluginMetadataSnapshot = vi.fn();
    const contribution = requireDoctorContribution("doctor:legacy-plugin-manifests");
    const ctx = createDoctorHealthFlowContext({
      cfg: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: buildDoctorPrompter(true),
      invalidatePluginMetadataSnapshot,
    });

    await contribution.run(ctx);

    expect(invalidatePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("runs release configured plugin install repair before plugin registry and final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(
      ids.indexOf("doctor:active-tool-schema-warnings"),
    );
  });

  it("repairs canonical session rows before downstream agent-state checks", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:legacy-state")).toBeLessThan(
      ids.indexOf("doctor:session-transcripts"),
    );
    expect(ids.indexOf("doctor:session-transcripts")).toBeLessThan(
      ids.indexOf("doctor:agent-memory-schema"),
    );
    expect(ids.indexOf("doctor:session-transcripts")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
  });

  it("orders the config-flow commit before runtime-backed diagnostics", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const migrationWriteIndex = ids.indexOf("doctor:write-config-migrations");

    expect(migrationWriteIndex).toBe(0);
    expect(migrationWriteIndex).toBeLessThan(ids.indexOf("doctor:active-tool-schema-warnings"));
    expect(migrationWriteIndex).toBeLessThan(ids.indexOf("doctor:hooks-model"));
    expect(migrationWriteIndex).toBeLessThan(ids.indexOf("doctor:runtime-tool-schemas"));
    expect(migrationWriteIndex).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("keeps a late runtime publication failure after committing config migrations", async () => {
    const cfg = { hooks: { gmail: { model: "openai/gpt-5.5" } } } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });
    const timeout = new Error("prepared model runtime publication timed out");
    mocks.collectActiveToolSchemaProjectionWarnings.mockResolvedValueOnce([
      `- agents.main: active tool schema validation could not resolve the runtime model context (${timeout.message}).`,
    ]);
    mocks.loadModelCatalog.mockRejectedValueOnce(timeout);

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);
    await requireDoctorContribution("doctor:active-tool-schema-warnings").run(ctx);
    await expect(requireDoctorContribution("doctor:hooks-model").run(ctx)).rejects.toThrow(
      timeout.message,
    );

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(ctx.configResultWriteCommitted).toBe(true);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(timeout.message),
      "Doctor warnings",
    );
  });

  it("persists migrated Discord config once across both write phases", async () => {
    const cfg = {
      channels: { discord: { streaming: { mode: "partial" } } },
    } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);
    await requireDoctorContribution("doctor:write-config").run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: cfg }),
    );
    expect(ctx.configResultWriteCommitted).toBe(true);
    expect(ctx.cfgForPersistence).toEqual(ctx.cfg);
  });

  it("does not mark an invalid migration durable when validation rejects the write", async () => {
    const cfg = { gateway: { mode: "invalid" } } as unknown as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(
      new Error(
        'Config validation failed: gateway.mode: Invalid input (allowed: "local", "remote")',
      ),
    );

    // Untyped write errors still propagate; only typed validation refusals render notes.
    await expect(
      requireDoctorContribution("doctor:write-config-migrations").run(ctx),
    ).rejects.toThrow("Config validation failed");

    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    expect(mocks.collectActiveToolSchemaProjectionWarnings).not.toHaveBeenCalled();
  });

  it("reports unapplied fixes and holds change panels when write validation refuses the candidate", async () => {
    // Regression: unknown root key repaired + type error elsewhere. Doctor used to
    // print "Doctor changes — gatway", then crash with a raw Error and persist nothing.
    const cfg = {
      agents: { defaults: { heartbeat: { every: 5 } } },
    } as unknown as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: {
        cfg,
        shouldWriteConfig: true,
        pendingChangePanels: ["- gatway"],
      },
      sourceConfigValid: false,
      shouldRepair: true,
      env: {},
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Config validation failed: agents.defaults.heartbeat.every: Invalid input: expected string, received number",
        ),
        {
          code: "CONFIG_VALIDATION_FAILED",
          issues: [
            {
              path: "agents.defaults.heartbeat.every",
              message: "Invalid input: expected string, received number",
            },
          ],
        },
      ),
    );

    const laterRun = vi.fn(async () => undefined);
    await runDoctorHealthContributionList(ctx, [
      requireDoctorContribution("doctor:write-config-migrations"),
      createDoctorHealthContribution({
        id: "doctor:test-later",
        label: "Test later",
        run: laterRun,
      }),
    ]);

    // The refusal is a rendered warning, not a crash. Later repairs consume the
    // candidate config, so the loop stops before they persist state derived
    // from a config that never reached disk (same invariant as cron deferral).
    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configWriteRefusal).toBe("validation");
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    // Never print "Doctor changes" for changes that were not persisted.
    expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("No config changes were written"),
      "Doctor warnings",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("agents.defaults.heartbeat.every"),
      "Doctor warnings",
    );

    // A later write pass must not retry the identical candidate or duplicate the warning.
    mocks.note.mockClear();
    mocks.replaceConfigFile.mockClear();
    await requireDoctorContribution("doctor:write-config").run(ctx);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("describes only the failed later write after an earlier pass committed", async () => {
    // First write pass commits; a later health repair then produces a candidate the
    // writer refuses. The warning must not claim the whole run wrote nothing.
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);
    expect(ctx.configResultWriteCommitted).toBe(true);

    // A later repair mutates the candidate; the final write pass is refused.
    ctx.cfg = {
      ...ctx.cfg,
      agents: { defaults: { heartbeat: { every: 5 } } },
    } as unknown as OpenClawConfig;
    mocks.note.mockClear();
    mocks.replaceConfigFile.mockRejectedValueOnce(
      Object.assign(new Error("Config validation failed: agents.defaults.heartbeat.every"), {
        code: "CONFIG_VALIDATION_FAILED",
        issues: [
          {
            path: "agents.defaults.heartbeat.every",
            message: "Invalid input: expected string, received number",
          },
        ],
      }),
    );
    await requireDoctorContribution("doctor:write-config").run(ctx);

    expect(ctx.configWriteRefusal).toBe("validation");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Earlier config fixes were already saved"),
      "Doctor warnings",
    );
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("No config changes were written"),
      "Doctor warnings",
    );
  });

  it("prints held change panels as Doctor changes only after the write commits", async () => {
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: {
        cfg,
        shouldWriteConfig: true,
        pendingChangePanels: ["- gatway"],
      },
      shouldRepair: true,
      env: {},
    });

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.note).toHaveBeenCalledWith("- gatway", "Doctor changes");
    expect(ctx.configResultWriteCommitted).toBe(true);
    // Panels print exactly once even when the final writer runs again.
    mocks.note.mockClear();
    await requireDoctorContribution("doctor:write-config").run(ctx);
    expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
  });

  it("defers every config write after a cron ownership handoff refusal", async () => {
    const laterRun = vi.fn(async () => undefined);
    const cfg = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Config write refused: cannot inspect cron ownership. Run "openclaw doctor --fix", then retry.',
        ),
        { code: "CONFIG_WRITE_REJECTED", refusal: "cron-owner-safety" },
      ),
    );

    await runDoctorHealthContributionList(ctx, [
      requireDoctorContribution("doctor:write-config-migrations"),
      createDoctorHealthContribution({
        id: "doctor:test-later",
        label: "Test later",
        run: laterRun,
      }),
    ]);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.configWriteRefusal).toBe("cron-owner-safety");
    expect(ctx.cfgForPersistence).toEqual(cfg);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("preserving any retained legacy owner"),
      "Doctor warnings",
    );
  });

  it("skips read-scope gateway probes when gateway health only proved reachability", async () => {
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: false,
      healthOk: true,
      status: { ok: true },
    });
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      env: {},
    });

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
    const cfg = createDoctorConfigFixture({
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
    });
    const ctx = createDoctorContext({ cfg, env: {} });

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
    const cfg = createDoctorConfigFixture({
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
    });
    const ctx = createDoctorContext({ cfg, env: {} });

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
    const ctx = createDoctorHealthFlowContext({
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      env: {},
    });

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("stamps release configured plugin installs after repair changes", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
      pluginInventoryChanged: true,
    });
    const invalidatePluginMetadataSnapshot = vi.fn();
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = createDoctorHealthFlowContext({
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      env: {},
      invalidatePluginMetadataSnapshot,
    });

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
    expect(invalidatePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps legacy parent writable release repairs old-parent-readable", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.16-beta.4" },
      cfgForPersistence: {},
      shouldRepair: true,
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      },
    });

    await contribution.run(ctx);

    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.16-beta.4");
    expect(readConfigMachineState<string>("config.lastTouchedAt")).toEqual(expect.any(String));
  });

  it("checks command owner configuration before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:command-owner")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:command-owner")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("runs the web fetch proxy diagnostic after security checks", async () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const contribution = requireDoctorContribution("doctor:web-fetch-proxy");
    const cfg = { gateway: { mode: "local" as const } };
    const env = { HTTPS_PROXY: "http://proxy.example:8080" };
    const ctx = createDoctorHealthFlowContext({ cfg, env });

    expect(ids.indexOf("doctor:security")).toBeLessThan(ids.indexOf("doctor:web-fetch-proxy"));
    await contribution.run(ctx);

    expect(mocks.noteWebFetchProxyDiagnostic).toHaveBeenCalledWith({ cfg, env });
  });

  it("checks skill readiness before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:skills")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:skills")).toBeLessThan(ids.indexOf("doctor:write-config"));
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
    const ctx = createDoctorLintContext({
      cfg: { plugins: { entries: { codex: { enabled: true } } } },
      mode: "lint",
      allowExecSecretRefs: true,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

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

    await contribution.run(
      createDoctorHealthFlowContext({
        cfg,
        options: { nonInteractive: true },
      }),
    );

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

    await contribution.run(
      createDoctorHealthFlowContext({
        cfg,
        options: { nonInteractive: true },
      }),
    );

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

    await contribution.run(
      createDoctorHealthFlowContext({
        cfg,
        options: { nonInteractive: true },
      }),
    );

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

  it("keeps workspace diagnostics without probing host services in Kubernetes", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.96.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const cfg = { plugins: { entries: { codex: { enabled: true } } } };

    await contribution.run(createDoctorContext({ cfg, options: { nonInteractive: true } }));

    expect(mocks.gatherDaemonStatus).not.toHaveBeenCalled();
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionDrift: undefined,
    });

    const ctx = createDoctorLintContext({
      cfg,
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const check = contribution.healthChecks[0] as HealthCheck;
    await runDoctorLintChecks(ctx, { checks: [check], onlyIds: ["core/doctor/workspace-status"] });

    expect(mocks.gatherDaemonStatus).not.toHaveBeenCalled();
    expect(mocks.collectWorkspaceStatusHealthFindings).toHaveBeenCalledWith(cfg, {
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
    const ctx = createDoctorHealthFlowContext({
      cfg,
      options: {},
    });

    await contribution.run(ctx);

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      readOnly: true,
      providerDiscoveryProviderIds: [],
    });
  });

  it("materializes heartbeat cadence before scratch migration and final config writes", async () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const cadenceIndex = ids.indexOf("doctor:heartbeat-cadence-migration");
    const scratchIndex = ids.indexOf("doctor:heartbeat-scratch-migration");

    expect(cadenceIndex).toBeGreaterThan(-1);
    expect(cadenceIndex).toBeLessThan(scratchIndex);
    expect(scratchIndex).toBeLessThan(ids.indexOf("doctor:write-config"));

    const contribution = requireDoctorContribution("doctor:heartbeat-cadence-migration");
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    await contribution.run(
      createDoctorHealthFlowContext({
        cfg,
        prompter: buildDoctorPrompter(true),
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      }),
    );

    expect(mocks.maybeMigrateHeartbeatCadenceToCron).toHaveBeenCalledWith({
      cfg,
      shouldRepair: true,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });
  });

  it("forwards the health-check environment to heartbeat cadence detection", async () => {
    const checks = await resolveDoctorContributionHealthChecks();
    const check = checks.find(
      (candidate) => candidate.id === "core/doctor/heartbeat-cadence-migration",
    );
    expect(check).toBeDefined();
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-detector-state" };

    await check!.detect(createDoctorLintFixture(cfg, { env }));

    expect(mocks.collectHeartbeatCadenceMigrationFindings).toHaveBeenCalledWith(cfg, env);
  });

  it("migrates heartbeat files before converting their task blocks", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const cadenceIndex = ids.indexOf("doctor:heartbeat-cadence-migration");
    const scratchIndex = ids.indexOf("doctor:heartbeat-scratch-migration");
    const taskIndex = ids.indexOf("doctor:heartbeat-task-cron-migration");

    expect(cadenceIndex).toBeGreaterThan(-1);
    expect(scratchIndex).toBeGreaterThan(cadenceIndex);
    expect(scratchIndex).toBeGreaterThan(-1);
    expect(taskIndex).toBeGreaterThan(scratchIndex);
    expect(taskIndex).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("forwards the health-check environment to heartbeat task detection", async () => {
    const checks = await resolveDoctorContributionHealthChecks();
    const check = checks.find(
      (candidate) => candidate.id === "core/doctor/heartbeat-task-cron-migration",
    );
    expect(check).toBeDefined();
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-task-detector-state" };

    await check!.detect(createDoctorLintFixture(cfg, { env }));

    expect(mocks.collectHeartbeatTaskMigrationFindings).toHaveBeenCalledWith(cfg, env);
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

    const ctx = createDoctorLintFixture(
      createDoctorConfigFixture({
        channels: {
          telegram: {
            accounts: {
              alerts: {},
              work: {},
            },
          },
        },
        bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
      }),
    );

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
    const ctx = createDoctorContext({
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "exec-token" },
        },
      },
      options: { allowExec: true, nonInteractive: true },
      env: { OPENCLAW_TEST_GATEWAY_TOKEN: "1" },
      configPath: "/tmp/openclaw.json",
    });

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
    const ctx = createDoctorContext({
      cfg: { gateway: { mode: "local" } },
      configResult: {},
      shouldRepair: true,
      options: { allowExec: true },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    expect(mocks.maybeRepairGatewayServiceConfig).toHaveBeenCalledWith(
      ctx.cfg,
      "local",
      ctx.runtime,
      ctx.prompter,
      expect.objectContaining({ allowExecSecretRefs: true }),
    );
  });

  it("repairs an installed Gateway service during an authorized update inside Docker", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);

    await withProcessPlatform("linux", async () => {
      const ctx = createDoctorContext({
        cfg: { gateway: { mode: "local" } },
        shouldRepair: true,
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "1",
        },
      });

      await requireDoctorContribution("doctor:gateway-services").run(ctx);

      expect(mocks.maybeRepairGatewayServiceConfig).toHaveBeenCalledOnce();
    });
  });

  it("silently skips the host-service contribution in a container without an OpenClaw service", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue(null);
    const contribution = requireDoctorContribution("doctor:gateway-services");
    const ctx = createDoctorContext({
      cfg: { gateway: { mode: "local" } },
      configResult: {},
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
    });

    await contribution.run(ctx);

    expect(mocks.maybeScanExtraGatewayServices).not.toHaveBeenCalled();
    expect(mocks.maybeResolveDuelingSystemdGatewayScopes).not.toHaveBeenCalled();
    expect(mocks.maybeRepairGatewayServiceConfig).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("hints how to enable authenticated GitHub project search", async () => {
    const contribution = requireDoctorContribution("doctor:github-projects");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: {},
      env: {},
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("shared Gateway process environment"),
      "GitHub projects",
    );

    mocks.note.mockClear();
    await contribution.run({ ...ctx, env: { GH_TOKEN: "configured" } });
    expect(mocks.note).not.toHaveBeenCalled();

    await contribution.run({
      ...ctx,
      cfg: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "CONTROL_UI_GITHUB" },
            },
          },
        },
      },
    });
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("passes the active config into legacy state migration", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    const legacyStateCheck = CORE_HEALTH_CHECKS.find(
      (check) => check.id === "core/doctor/legacy-state",
    );
    expect(legacyStateCheck).toMatchObject({ defaultEnabled: false });

    const cfg = { session: { store: "/tmp/shared-sessions.json" } };
    const detected = { preview: ["legacy sessions"], warnings: [], notices: [] };
    mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
    const ctx = createDoctorContext({
      cfg,
      configResult: {},
      shouldRepair: true,
      options: { nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    const detectParams = mocks.detectLegacyStateMigrations.mock.calls[0]?.[0] as
      | {
          legacySessionSurfaces?: unknown;
        }
      | undefined;
    const legacySessionSurfaces = detectParams?.legacySessionSurfaces;
    expect(legacySessionSurfaces).toMatchObject({ failures: [], surfaces: expect.any(Array) });
    expect(mocks.detectLegacyStateMigrations).toHaveBeenCalledWith({
      cfg,
      legacySessionSurfaces,
    });
    expect(mocks.runLegacyStateMigrations).toHaveBeenCalledWith({
      detected,
      config: cfg,
      legacySessionSurfaces,
      recoverCorruptTargetStore: false,
    });
  });

  it("reports removed Workspaces state during non-fix doctor runs", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    mocks.runDoctorHealthRepairs.mockImplementation(async (input: { cfg?: unknown }) => ({
      config: input.cfg ?? {},
      findings: [
        {
          checkId: "core/doctor/removed-workspaces-state",
          severity: "warning",
          message: "Retired Workspaces plugin state remains at /tmp/workspaces.",
          path: "/tmp/workspaces",
          fixHint: "Run openclaw doctor --fix.",
        },
      ],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 0,
      checksValidated: 1,
    }));
    const ctx = createDoctorContext({
      cfg: {},
      configResult: {},
      options: { nonInteractive: true },
    });

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "fix", dryRun: true }),
      expect.objectContaining({ dryRun: true }),
    );
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("core/doctor/removed-workspaces-state"),
    );
  });

  it("does not report a removed Workspaces finding after a successful fix", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    mocks.runDoctorHealthRepairs.mockImplementation(async (input: { cfg?: unknown }) => ({
      config: input.cfg ?? {},
      findings: [
        {
          checkId: "core/doctor/removed-workspaces-state",
          severity: "warning",
          message: "Retired Workspaces plugin state remains at /tmp/workspaces.",
        },
      ],
      remainingFindings: [],
      changes: ["Removed retired Workspaces plugin state at /tmp/workspaces."],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 1,
      checksValidated: 1,
    }));
    const ctx = createDoctorContext({
      cfg: {},
      configResult: {},
      shouldRepair: true,
      options: { nonInteractive: true },
    });

    await contribution.run(ctx);

    expect(ctx.runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("core/doctor/removed-workspaces-state"),
    );
  });

  it("grants Doctor-only state migration authority only in repair mode", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    const cfg = { session: { store: "/tmp/shared-sessions.json" } };
    const detected = { preview: ["legacy sessions"], warnings: [], notices: [] };
    mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
    const ctx = createDoctorContext({
      cfg,
      configResult: {},
      shouldRepair: true,
      options: { nonInteractive: true, repair: true },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    const detectParams = mocks.detectLegacyStateMigrations.mock.calls[0]?.[0] as
      | {
          legacySessionSurfaces?: unknown;
        }
      | undefined;
    const legacySessionSurfaces = detectParams?.legacySessionSurfaces;
    expect(legacySessionSurfaces).toMatchObject({ failures: [], surfaces: expect.any(Array) });
    expect(mocks.detectLegacyStateMigrations).toHaveBeenCalledWith({
      cfg,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces,
    });
    expect(mocks.runLegacyStateMigrations).toHaveBeenCalledWith({
      detected,
      config: cfg,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces,
      recoverCorruptTargetStore: true,
    });
  });

  it("prints legacy state migration notices during manual doctor runs", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    const detected = { preview: ["legacy sessions"], warnings: [], notices: [] };
    mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
    mocks.runLegacyStateMigrations.mockResolvedValue({
      changes: [],
      warnings: [],
      notices: ["Left reviewed legacy residue in place."],
    });
    const ctx = createDoctorContext({
      cfg: {},
      configResult: {},
      shouldRepair: true,
      options: { nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    });

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
    const ctx = createDoctorContext({
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "exec-token" },
        },
      },
      options: { nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health probes skipped"),
      "Gateway",
    );
  });

  it("runs the receipted auth migration after repairing OAuth sidecars", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const ctx = createDoctorContext({
      cfg: {},
      shouldRepair: true,
      options: { nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    expect(mocks.maybeRepairLegacyOAuthSidecarProfiles).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
    });
    expect(mocks.maybeMigrateAuthProfileJsonStoresToSqlite).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
    });
    expect(mocks.maybeRepairLegacyOAuthSidecarProfiles.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mock.invocationCallOrder[0]!,
    );
    expect(mocks.maybeMigrateLegacyPluginModelCatalogs).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
      runtime: ctx.runtime,
    });
    expect(mocks.maybeMigrateModelCatalogCredentials).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
      runtime: ctx.runtime,
    });
    expect(mocks.maybeRepairLegacyOAuthProfileIds.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.maybeMigrateModelCatalogCredentials.mock.invocationCallOrder[0]!,
    );
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    expect(mocks.noteAuthProfileHealth).toHaveBeenCalledOnce();
  });

  it("cleans retired auth profiles before reporting profile health", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const cfg = {
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" as const },
        },
      },
    };
    const repairedCfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
    mocks.maybeRepairLegacyOAuthProfileIds.mockResolvedValue({
      config: repairedCfg,
      retiredProfileCleanupPlans: [
        {
          agentDir: "/tmp/openclaw/agents/main",
          profileIds: ["anthropic:claude-cli"],
        },
      ],
    });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    });

    await contribution.run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: repairedCfg }),
    );
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      profileIds: ["anthropic:claude-cli"],
    });
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeAuthProfilesAcrossOwnerStores.mock.invocationCallOrder[0]!,
    );
    expect(mocks.removeAuthProfilesAcrossOwnerStores.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.noteAuthProfileHealth.mock.invocationCallOrder[0]!,
    );
    expect(ctx.configResult.retiredAuthProfileCleanupPlans).toBeUndefined();
  });

  it("does not clean or report retired profiles when an update handoff skips persistence", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const cfg = {};
    mocks.maybeRepairLegacyOAuthProfileIds.mockResolvedValue({
      config: { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } },
      retiredProfileCleanupPlans: [
        {
          agentDir: "/tmp/openclaw/agents/main",
          profileIds: ["anthropic:claude-cli"],
        },
      ],
    });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: cfg,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      prompter: buildDoctorPrompter(true),
    });

    await contribution.run(ctx);

    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    expect(mocks.noteAuthProfileHealth).not.toHaveBeenCalled();
    expect(ctx.configResult.retiredAuthProfileCleanupPlans).toHaveLength(1);
  });

  it("persists provider runtime mappings added while removing retired auth profiles", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const cfg = {
      agents: { defaults: { models: { "anthropic/claude-sonnet-4-6": {} } } },
    };
    mocks.maybeRepairLegacyOAuthProfileIds.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      retiredProfileCleanupPlans: [],
    });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    });

    await contribution.run(ctx);

    expect(ctx.configResult.explicitSetPaths).toContainEqual(["agents", "defaults", "models"]);
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

    await check.detect(createDoctorLintFixture({ auth: { profiles: {} } }));

    expect(mocks.collectAuthProfileHealthFindings).toHaveBeenCalledWith({
      cfg: { auth: { profiles: {} } },
      allowKeychainPrompt: false,
    });
  });

  it("forwards skipped Gateway health to daemon repair", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-daemon");
    const ctx = createDoctorContext({
      cfg: {},
      gatewayDetails: { message: "gateway details" },
      gatewayHealthSkipped: true,
      healthOk: false,
      shouldRepair: true,
      options: { nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    } as unknown as Parameters<typeof createDoctorContext>[0]);

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
    expect(contributionIds).toContain("core/doctor/whatsapp-responsiveness");
    expect(contributionIds).toContain("core/doctor/device-pairing");
    expect(contributionIds).toContain("core/doctor/node-hosting-preconditions");
    expect(contributionIds).toContain("core/doctor/channel-plugin-blockers");
    expect(contributionIds).toContain("core/doctor/channel-package-state-capabilities");
    expect(contributionIds).toContain("core/doctor/channel-preview-warnings");
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

    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });
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

  it("preserves interactive linger repair for a user-scoped Gateway service", async () => {
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const ctx = createDoctorContext({
      cfg: { gateway: { mode: "local" } },
    });

    await withProcessPlatform("linux", async () => {
      await contribution.run(ctx);
    });

    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalledOnce();
  });

  it("keeps selected systemd linger quiet when the gateway service is not loaded", async () => {
    mocks.gatewayServiceIsLoaded.mockResolvedValue(false);
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const systemdLingerCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/systemd-linger",
    );
    expect(systemdLingerCheck).toBeDefined();

    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });

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

  it("skips user lingering for a reachable system-scoped Gateway service in a container", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const checks = await resolveDoctorContributionHealthChecks();
    const lingerCheck = checks.find((check) => check.id === "core/doctor/systemd-linger");
    expect(lingerCheck).toBeDefined();
    const lintResult = await withProcessPlatform("linux", async () => {
      await contribution.run(
        createDoctorContext({
          cfg: { gateway: { mode: "local" } },
        }),
      );
      return await runDoctorLintChecks(createDoctorLintFixture({ gateway: { mode: "local" } }), {
        checks: [lingerCheck!],
        onlyIds: ["core/doctor/systemd-linger"],
      });
    });

    expect(mocks.findInstalledSystemdGatewayScope).toHaveBeenCalledTimes(2);
    expect(mocks.gatewayServiceIsLoaded).not.toHaveBeenCalled();
    expect(mocks.isSystemdUserServiceAvailable).not.toHaveBeenCalled();
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
    expect(lintResult).toMatchObject({ checksRun: 1, findings: [] });
    expect(JSON.stringify(lintResult)).not.toContain("loginctl enable-linger");
  });

  it("never probes systemd linger inside a container without an OpenClaw service", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue(null);
    const checks = await resolveDoctorContributionHealthChecks();
    const lingerCheck = checks.find((check) => check.id === "core/doctor/systemd-linger");
    expect(lingerCheck).toBeDefined();

    await withProcessPlatform("linux", async () => {
      await expect(
        runDoctorLintChecks(
          {
            cfg: { gateway: { mode: "local" } },
            mode: "lint",
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          },
          { checks: [lingerCheck!], onlyIds: ["core/doctor/systemd-linger"] },
        ),
      ).resolves.toMatchObject({ checksRun: 1, findings: [] });
    });

    expect(mocks.gatewayServiceIsLoaded).not.toHaveBeenCalled();
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
  });

  it("reports the Gateway service owner under sudo-to-root", async () => {
    mocks.resolveSystemdUserServiceAccount.mockReturnValue("debian");
    mocks.readSystemdUserLingerStatus.mockImplementation(async (params) =>
      params?.user === "debian" ? { user: "debian", linger: "no" } : null,
    );
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const systemdLingerCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/systemd-linger",
    );
    expect(systemdLingerCheck).toBeDefined();
    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });

    await withProcessPlatform("linux", async () => {
      await expect(
        runDoctorLintChecks(ctx, {
          checks: [systemdLingerCheck!],
          onlyIds: ["core/doctor/systemd-linger"],
        }),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            fixHint: "Run: sudo loginctl enable-linger debian",
            target: "systemd.user.debian",
          }),
        ],
      });
    });
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

    const ctx = createDoctorLintFixture();

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

  it("keeps legacy plugin dependency lint opt-in and read-only", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-legacy-plugin-deps-lint-",
    });
    const stateDir = openClawState.stateDir;
    const legacyRuntimeRoot = nodePath.join(stateDir, "plugin-runtime-deps");
    fs.mkdirSync(legacyRuntimeRoot, { recursive: true });
    try {
      const contributionChecks = await resolveDoctorContributionHealthChecks();
      const check = contributionChecks.find(
        (entry) => entry.id === "core/doctor/legacy-plugin-dependencies",
      );
      expect(check).toMatchObject({ defaultEnabled: false });
      expect(check).toBeDefined();

      const ctx = createDoctorLintFixture();

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
      await openClawState.cleanup();
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

    const ctx = createDoctorLintFixture();
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
    const env = { OPENCLAW_STATE_DIR: "/isolated-memory-state" };
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

    const findings = await check.detect(createDoctorLintFixture({}, { env }));

    expect(contribution.healthCheckIds).toEqual(["core/doctor/memory-search"]);
    expect((check as HealthCheck & { defaultEnabled?: boolean }).defaultEnabled).toBe(false);
    expect(mocks.noteMemorySearchHealth).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        env,
        includeWorkspaceMemoryHealth: false,
        skipAuthProfileResolution: true,
        gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
        noteFn: expect.any(Function),
      }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/memory-search",
        severity: "warning",
        path: "memory.search.provider",
        message: 'Memory search provider is set to "openai" but no API key was found.',
        fixHint: expect.stringContaining("OPENAI_API_KEY"),
      }),
    ]);
  });

  it("forwards the interactive Doctor environment to memory provider discovery", async () => {
    const contribution = requireDoctorContribution("doctor:memory-search");
    const env = { OPENCLAW_STATE_DIR: "/interactive-memory-state" };

    await contribution.run(createDoctorContext({ env }));

    expect(mocks.noteMemorySearchHealth).toHaveBeenCalledWith({}, expect.objectContaining({ env }));
  });

  it("does not report disabled memory search as a lint warning", async () => {
    const contribution = requireDoctorContribution("doctor:memory-search");
    const check = contribution.healthChecks[0] as HealthCheck;
    mocks.noteMemorySearchHealth.mockImplementationOnce(async (_cfg, opts) => {
      opts.noteFn("Memory search is explicitly disabled (enabled: false).", "Memory search");
    });

    const findings = await check.detect(createDoctorLintFixture());

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

    const ctx = createDoctorLintFixture();
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

  it("labels normal workspace suggestions for secondary agents", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-suggestions");
    const cfg = {} as OpenClawConfig;
    const ctx = createDoctorContext({ cfg, env: {} });
    mocks.listAgentIds.mockReturnValue(["default", "secondary"]);
    mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    mocks.collectWorkspaceBackupTip.mockImplementation((workspaceDir) =>
      workspaceDir === "/tmp/secondary" ? "- Back up this workspace." : undefined,
    );
    mocks.shouldSuggestMemorySystem.mockImplementation(
      async (workspaceDir) => workspaceDir === "/tmp/secondary",
    );

    await contribution.run(ctx);

    expect(mocks.note).toHaveBeenCalledWith(
      'Agent "secondary": - Back up this workspace.',
      "Workspace",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      'Agent "secondary": Enable memory system for better recall.',
      "Workspace",
    );
    expect(mocks.note).toHaveBeenCalledTimes(2);
  });

  it("keeps single-agent workspace suggestion wording unchanged", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-suggestions");
    const cfg = {} as OpenClawConfig;
    const ctx = createDoctorContext({ cfg, env: {} });
    mocks.collectWorkspaceBackupTip.mockReturnValue("- Back up this workspace.");
    mocks.shouldSuggestMemorySystem.mockResolvedValue(true);

    await contribution.run(ctx);

    expect(mocks.note).toHaveBeenNthCalledWith(1, "- Back up this workspace.", "Workspace");
    expect(mocks.note).toHaveBeenNthCalledWith(
      2,
      "Enable memory system for better recall.",
      "Workspace",
    );
  });

  it("keeps disk space opt-in for default lint selection", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const diskSpaceCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/disk-space",
    );
    expect(diskSpaceCheck).toMatchObject({ defaultEnabled: false });
    expect(diskSpaceCheck).toBeDefined();

    const ctx = createDoctorLintFixture();
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

    const ctx = createDoctorLintFixture(
      { channels: { whatsapp: { enabled: true } } },
      { allowExecSecretRefs: true },
    );
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
        degradedSinceMs: 61_000,
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

    const ctx = createDoctorLintFixture({ channels: { whatsapp: { enabled: true } } });
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

    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });
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

    const ctx = createDoctorLintFixture({ cron: { store: "/tmp/openclaw-cron/jobs.json" } });
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

    const ctx = createDoctorLintFixture();
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

    const ctx = createDoctorLintFixture({ channels: { discord: { enabled: true } } });
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

  it("reports channel package-state capability load failures by default", async () => {
    const contributionChecks = await resolveDoctorContributionHealthChecks();
    const capabilityCheck = contributionChecks.find(
      (check) => check.id === "core/doctor/channel-package-state-capabilities",
    );
    expect(capabilityCheck).toMatchObject({ defaultEnabled: true });
    expect(capabilityCheck).toBeDefined();
    mocks.collectBundledChannelPackageStateLoadFailures.mockReturnValue([
      {
        detail: "plugin module path not found: /plugins/example-chat/auth-presence",
        metadataKey: "persistedAuthState",
        pluginId: "example-chat",
      },
    ]);

    const ctx = createDoctorLintFixture();

    await expect(runDoctorLintChecks(ctx, { checks: [capabilityCheck!] })).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/channel-package-state-capabilities",
          severity: "warning",
          target: "example-chat",
          requirement: "declared-channel-package-state-capability-loadable",
        }),
      ],
    });
  });

  it("defers channel package-state loading only until post-core plugin convergence", async () => {
    const contribution = requireDoctorContribution("doctor:channel-package-state-capabilities");
    mocks.collectBundledChannelPackageStateLoadFailures.mockReturnValue([
      {
        detail: "plugin module path not found: /plugins/example-chat/auth-presence",
        metadataKey: "persistedAuthState",
        pluginId: "example-chat",
      },
    ]);
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
        checksValidated: 0,
      };
    });
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
    const ctx = createDoctorContext();

    await contribution.run(ctx);

    expect(mocks.collectBundledChannelPackageStateLoadFailures).not.toHaveBeenCalled();

    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");

    await contribution.run(ctx);

    expect(mocks.collectBundledChannelPackageStateLoadFailures).toHaveBeenCalledOnce();
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("core/doctor/channel-package-state-capabilities"),
    );
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

    const ctx = createDoctorLintFixture({ channels: { matrix: { enabled: true } } });
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
    const ctx = createDoctorLintFixture(
      { channels: { matrix: { enabled: true } } },
      { allowExecSecretRefs: true },
    );

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
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      shouldRepair: true,
    });

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
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      shouldRepair: true,
    });

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

  it.each([
    ["explicit multi-agent config", undefined, undefined],
    ["sole-agent config", "default", "/tmp/openclaw-workspace"],
  ])("uses %s workspace scope for metadata and structured health", async (_, soleAgentId, cwd) => {
    mocks.tryResolveSoleAgentId.mockReturnValue(soleAgentId);
    const runWithPluginMetadataSnapshot = vi.fn((_scope: unknown, run: () => unknown) =>
      run(),
    ) as unknown as NonNullable<DoctorContributionRunContext["runWithPluginMetadataSnapshot"]>;
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-workspace-scope",
      label: "Test workspace scope",
      healthChecks: {
        description: "test workspace scope",
        detect: vi.fn(async () => []),
      },
    });
    const ctx = createDoctorContext({
      cfg: { agents: { ownership: "explicit" } },
      cfgForPersistence: {},
      configResult: { cfg: {} },
      shouldRepair: true,
      env: {},
      runWithPluginMetadataSnapshot,
    });

    await runDoctorHealthContributionList(ctx, [contribution]);

    expect(runWithPluginMetadataSnapshot).toHaveBeenCalledWith(
      { config: ctx.cfg, workspaceDir: cwd },
      expect.any(Function),
    );
    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(expect.objectContaining({ cwd }), {
      checks: contribution.healthChecks,
      dryRun: false,
    });
    if (soleAgentId === undefined) {
      expect(mocks.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    } else {
      expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(ctx.cfg, soleAgentId, ctx.env);
    }
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
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
    });

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
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
    });

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
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      shouldRepair: true,
    });

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
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: {},
    });

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(expect.any(Object), {
      checks: [{ id: "plugin/example/unrelated", kind: "plugin", sourceContract: "split" }],
    });
  });

  it("rejects extension repairs that claim reserved core doctor ids", async () => {
    mocks.listHealthChecks.mockReturnValue([
      { id: "plugin/example/unrelated", kind: "plugin" },
      { id: "core/doctor/shell-completion", kind: "plugin" },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: {},
    });

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
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: {},
    });

    await expect(contribution.run(ctx)).rejects.toThrow(
      "health check already registered: core/doctor/shell-completion",
    );
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
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
      const ctx = createDoctorContext({
        cfg: createDoctorConfigFixture({
          channels: {
            telegram: {
              accounts: {
                alerts: {},
                work: {},
              },
            },
          },
          bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
        }),
        configResult: { cfg: {} },
        cfgForPersistence: {},
        shouldRepair,
        env: {},
      });

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

  describe("write-config lint findings", () => {
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");
    const check = writeConfigContribution.healthChecks[0] as HealthCheck & {
      defaultEnabled?: boolean;
    };

    it("keeps write-config lint opt-in for structured findings", async () => {
      expect(writeConfigContribution.healthCheckIds).toEqual(["core/doctor/write-config"]);
      expect(check.defaultEnabled).toBe(false);

      const ctx = createDoctorLintFixture({}, { configPath: "/tmp/fake-openclaw.json" });

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
    const migrationWriteContribution = requireDoctorContribution("doctor:write-config-migrations");
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

    const ctx = createDoctorContext({
      cfg: originalCfg,
      cfgForPersistence: originalCfg,
      configResult: {
        cfg: originalCfg,
        preservedLegacyRootKeys: ["defaultModel"],
        shouldWriteConfig: true,
        skipPluginValidationOnWrite: true,
      },
      shouldRepair: true,
      env: {},
    });

    await migrationWriteContribution.run(ctx);
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
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        nextConfig: originalCfg,
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nextConfig: repairedCfg,
      }),
    );
  });

  it("does not suggest --fix after a clean doctor run", async () => {
    const cfg = {};
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await requireDoctorContribution("doctor:write-config").run(
      createDoctorContext({
        cfg,
        configResult: { cfg, shouldWriteConfig: false },
        runtime,
        env: {},
      }),
    );

    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("persists an announced legacy SecretRef migration idempotently", async () => {
    const legacyMarker = `${LEGACY_SECRETREF_ENV_MARKER_PREFIX}TEST_ENV_REF`;
    const testApiKey = legacyMarker;
    const legacyConfig = {
      models: {
        providers: {
          clawrouter: {
            api: "openai-completions",
            apiKey: testApiKey,
            baseUrl: "https://clawrouter.example/v1",
            models: [
              {
                id: "test-model",
                name: "Test Model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 2048,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    const migrated = migrateLegacySecretRefEnvMarkers(legacyConfig);
    expect(migrated.changes).toEqual([
      `Moved models.providers.clawrouter.apiKey ${legacyMarker} marker → structured env SecretRef.`,
    ]);
    const ctx = createDoctorContext({
      cfg: migrated.config,
      cfgForPersistence: legacyConfig,
      configResult: { cfg: migrated.config, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");

    await writeConfigContribution.run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: migrated.config }),
    );
    expect(migrated.config.models?.providers?.clawrouter?.apiKey).toEqual({
      id: "TEST_ENV_REF",
      provider: "default",
      source: "env",
    });

    mocks.replaceConfigFile.mockClear();
    ctx.cfgForPersistence = structuredClone(ctx.cfg);
    ctx.configResult.shouldWriteConfig = false;
    await writeConfigContribution.run(ctx);

    expect(migrateLegacySecretRefEnvMarkers(ctx.cfg).changes).toEqual([]);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("does not commit deferred cron migration when the config write fails", async () => {
    const cfg = { agents: { defaults: { models: {} } } } as OpenClawConfig;
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config write failed"));
    const ctx = {
      cfg,
      cfgForPersistence: cfg,
      configResult: {
        cfg,
        shouldWriteConfig: true,
        shouldRepairCronCodexModelRefsAfterConfigWrite: true,
        blockedCodexModelIdentities: ["codex\u0000gpt-5.6-sol"],
      },
      configPath: "/tmp/fake-openclaw.json",
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
    } as DoctorContributionRunContext;

    await expect(requireDoctorContribution("doctor:write-config").run(ctx)).rejects.toThrow(
      "config write failed",
    );
    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it("keeps deferred cron migration in the final phase after the early config write", async () => {
    const cfg = { agents: { defaults: { models: {} } } } as OpenClawConfig;
    const ctx = {
      cfg,
      cfgForPersistence: cfg,
      configResult: {
        cfg,
        shouldWriteConfig: true,
        shouldRepairCronCodexModelRefsAfterConfigWrite: true,
        blockedCodexModelIdentities: ["codex\u0000gpt-5.6-sol"],
      },
      configPath: "/tmp/fake-openclaw.json",
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
    } as DoctorContributionRunContext;

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);

    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).not.toHaveBeenCalled();

    await requireDoctorContribution("doctor:write-config").run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).toHaveBeenCalledWith({
      cfg,
      blockedModelIdentities: new Set(["codex\u0000gpt-5.6-sol"]),
    });
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.repairCronCodexModelRefsAfterConfigWrite.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("preserves a single-file include write by omitting wizard metadata", async () => {
    const cfg = { mcp: { servers: { local: { command: "node", enabled: false } } } };
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await requireDoctorContribution("doctor:write-config").run(
      createDoctorContext({
        cfg,
        configResult: {
          cfg,
          shouldWriteConfig: true,
          skipWizardMetadataForIncludeWrite: true,
        },
        shouldRepair: true,
        runtime,
        env: {},
      }),
    );

    expect(mocks.applyWizardMetadata).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: cfg }),
    );
  });

  describe("config size drops during update", () => {
    beforeEach(() => {
      mocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
    });

    function buildWriteConfigCtx(env: Record<string, string | undefined>) {
      const cfg: OpenClawConfig = { gateway: { mode: "local" } };
      return createDoctorContext({
        cfg,
        cfgForPersistence: { gateway: { mode: "remote" } },
        configResult: {
          cfg,
          shouldWriteConfig: true,
          skipPluginValidationOnWrite: false,
        },
        shouldRepair: true,
        env,
      });
    }

    const writeConfigContribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:write-config",
    )!;

    it.each([
      {
        name: "legacy update parents",
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
        shouldWrite: false,
      },
      { name: "ordinary doctor runs", env: {}, shouldWrite: true },
      {
        name: "current update parents",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        shouldWrite: true,
      },
      {
        name: "legacy protocol's broad parent opt-in",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "enabled",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "supported",
        },
        shouldWrite: true,
      },
      {
        name: "falsey update env values",
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
        shouldWrite: true,
      },
    ])("handles config writes for $name", async ({ env, shouldWrite }) => {
      const ctx = buildWriteConfigCtx(env);

      await writeConfigContribution.run(ctx);

      if (shouldWrite) {
        expect(mocks.replaceConfigFile).toHaveBeenCalled();
      } else {
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expect(ctx.runtime.log).toHaveBeenCalledWith(
          "Skipping doctor config write during legacy update handoff.",
        );
      }
    });

    it("allows config size drops when OPENCLAW_UPDATE_IN_PROGRESS=1", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            auditOrigin: "doctor",
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

    it("forwards explicit paths through later doctor repair writes", async () => {
      const ctx = buildWriteConfigCtx({});
      ctx.configResult.explicitSetPaths = [["agents", "entries"]];

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            explicitSetPaths: [["agents", "entries"]],
          }),
        }),
      );

      ctx.cfg = { gateway: { mode: "remote" } };
      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
      expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            explicitSetPaths: [["agents", "entries"]],
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

      await contribution.run(
        createDoctorContext({
          cfg: {},
          cfgForPersistence: {},
          configResult: { cfg: {} },
          shouldRepair: true,
          env: {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
          },
        }),
      );

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: true,
      });
    });

    it("keeps plugin schema validation for ordinary doctor final validation", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run(
        createDoctorContext({
          cfg: {},
          cfgForPersistence: {},
          configResult: { cfg: {} },
          shouldRepair: true,
          env: {},
        }),
      );

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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
