/** Non-deep audit facade for cheap summary/config findings. */
export {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.summary.js";

export {
  collectExposureMatrixFindings,
  collectGatewayHttpNoAuthFindings,
  collectGatewayHttpSessionKeyOverrideFindings,
  collectHooksHardeningFindings,
  collectLikelyMultiUserSetupFindings,
  collectMinimalProfileOverrideFindings,
  collectModelHygieneFindings,
  collectNodeDangerousAllowCommandFindings,
  collectNodeDenyCommandPatternFindings,
  collectSandboxDangerousConfigFindings,
  collectSandboxDockerNoopFindings,
  collectSecretsInConfigFindings,
  collectSyncedFolderFindings,
} from "./audit-extra.sync.js";

export {
  collectSandboxBrowserHashLabelFindings,
  collectIncludeFilePermFindings,
  collectStateDeepFilesystemFindings,
  readConfigSnapshotForAudit,
} from "./audit-extra.async.js";
export { collectWorkspaceSkillSymlinkEscapeFindings } from "../skills/security/workspace-audit.js";
export { collectPluginsTrustFindings } from "./audit-plugins-trust.js";
