export {
  resolveSandboxBrowserConfig,
  resolveSandboxConfigForAgent,
  resolveSandboxDockerConfig,
  resolveSandboxPruneConfig,
  resolveSandboxScope,
} from "./sandbox/config.js";
export {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
} from "./sandbox/constants.js";
export { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox/context.js";
export {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  registerSandboxBackend,
  requireSandboxBackendFactory,
} from "./sandbox/backend.js";

export { buildSandboxCreateArgs, isDockerDaemonUnavailable } from "./sandbox/docker.js";
export {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
  type SandboxBrowserInfo,
  type SandboxContainerInfo,
} from "./sandbox/manage.js";
export {
  formatSandboxToolPolicyBlockedMessage,
  resolveSandboxRuntimeStatus,
} from "./sandbox/runtime-status.js";

export { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
export type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./sandbox/fs-bridge.js";
export {
  buildExecRemoteCommand,
  buildRemoteCommand,
  buildSshSandboxArgv,
  createSshSandboxSessionFromConfigText,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  shellEscape,
  uploadDirectoryToSshTarget,
} from "./sandbox/ssh.js";
export { sanitizeEnvVars } from "./sandbox/sanitize-env-vars.js";
export { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
export { createWritableRenameTargetResolver } from "./sandbox/fs-bridge-rename-targets.js";
export { resolveWritableRenameTargets } from "./sandbox/fs-bridge-rename-targets.js";
export { resolveWritableRenameTargetsForBridge } from "./sandbox/fs-bridge-rename-targets.js";

export type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
} from "./sandbox/backend.js";
export type { RemoteShellSandboxHandle } from "./sandbox/remote-fs-bridge.js";
export type {
  RunSshSandboxCommandParams,
  SshSandboxSession,
  SshSandboxSettings,
} from "./sandbox/ssh.js";

export type {
  SandboxBrowserConfig,
  SandboxBrowserContext,
  SandboxConfig,
  SandboxContext,
  SandboxDockerConfig,
  SandboxPruneConfig,
  SandboxScope,
  SandboxSshConfig,
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxToolPolicySource,
  SandboxWorkspaceAccess,
  SandboxWorkspaceInfo,
} from "./sandbox/types.js";
