/** Fast-path module mocks for doctor command tests that do not need full integrations. */
import { vi } from "vitest";

vi.mock("./doctor-completion.js", () => ({
  doctorShellCompletion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-bootstrap-size.js", () => ({
  noteBootstrapFileSize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-auth-flat-profiles.js", () => ({
  maybeRepairCanonicalApiKeyFieldAlias: vi.fn(async (params: { cfg: unknown }) => params.cfg),
  maybeMigrateAuthProfileJsonStoresToSqlite: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  maybeRepairLegacyFlatAuthProfileStores: vi.fn().mockResolvedValue(undefined),
  maybeRepairOpenAICodexAuthConfig: vi.fn((cfg: unknown) => cfg),
  maybeRepairOpenAICodexAuthProfileStores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (cfg: unknown) => cfg),
}));

vi.mock("./doctor-auth-oauth-sidecar.js", () => ({
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-browser.js", () => ({
  detectLegacyClawdBrowserProfileResidue: vi.fn().mockResolvedValue(null),
  maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  noteChromeMcpBrowserReadiness: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-claude-cli.js", () => ({
  noteClaudeCliHealth: vi.fn(),
}));

vi.mock("./doctor-command-owner.js", () => ({
  noteCommandOwnerHealth: vi.fn(),
}));

vi.mock("./doctor-config-audit-scrub.js", () => ({
  maybeScrubConfigAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-usage-cost-cache.js", () => ({
  maybeRepairLegacyRuntimeFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor/cron/index.js", () => ({
  maybeRepairLegacyCronStore: vi.fn().mockResolvedValue(undefined),
  noteLegacyWhatsAppCrontabHealthCheck: vi.fn().mockResolvedValue(undefined),
  repairLegacyCronStoreWithoutPrompt: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
}));

vi.mock("./doctor-device-pairing.js", () => ({
  noteDevicePairingHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-gateway-daemon-flow.js", () => ({
  maybeRepairGatewayDaemon: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-gateway-health.js", () => ({
  checkGatewayHealth: vi.fn().mockResolvedValue({ healthOk: false }),
  probeGatewayMemoryStatus: vi
    .fn()
    .mockResolvedValue({ checked: false, ready: false, skipped: false }),
}));

vi.mock("./doctor-memory-search.js", () => ({
  maybeRepairMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemorySearchHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-plugin-manifests.js", () => ({
  maybeRepairLegacyPluginManifestContracts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-plugin-registry.js", () => ({
  maybeRepairPluginRegistryState: vi.fn(async ({ config }: { config: unknown }) => config),
}));

vi.mock("./doctor-platform-notes.js", () => ({
  noteStartupOptimizationHints: vi.fn(),
  noteMacLaunchAgentOverrides: vi.fn().mockResolvedValue(undefined),
  noteMacStaleOpenClawUpdateLaunchdJobs: vi.fn().mockResolvedValue(undefined),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-sandbox.js", () => ({
  maybeRepairSandboxImages: vi.fn(async (cfg: unknown) => cfg),
  maybeRepairSandboxRegistryFiles: vi.fn().mockResolvedValue(undefined),
  noteSandboxScopeWarnings: vi.fn(),
}));

vi.mock("./doctor-security.js", () => ({
  noteSecurityWarnings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-install-policy.js", () => ({
  noteInstallPolicyHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-session-locks.js", () => ({
  noteSessionLockHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-session-transcripts.js", () => ({
  noteSessionTranscriptHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-session-snapshots.js", () => ({
  noteSessionSnapshotHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-skills.js", () => ({
  maybeRepairSkillReadiness: vi.fn(async ({ cfg }: { cfg: unknown }) => cfg),
}));

vi.mock("./doctor-state-integrity.js", () => ({
  noteStateIntegrity: vi.fn().mockResolvedValue(undefined),
  noteWorkspaceBackupTip: vi.fn(),
}));

vi.mock("./doctor-ui.js", () => ({
  maybeRepairUiProtocolFreshness: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-whatsapp-responsiveness.js", () => ({
  noteWhatsappResponsivenessHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-workspace-status.js", () => ({
  noteWorkspaceStatus: vi.fn(),
}));

vi.mock("../flows/doctor-startup-channel-maintenance.js", () => ({
  maybeRunDoctorStartupChannelMaintenance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-heartbeat-template-repair.js", () => ({
  maybeRepairHeartbeatTemplate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../plugins/provider-openai-chatgpt-oauth-tls.js", () => ({
  noteOpenAIOAuthTlsPrerequisites: vi.fn().mockResolvedValue(undefined),
}));
