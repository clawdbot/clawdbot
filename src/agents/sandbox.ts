/**
 * Public sandbox barrel for agent runtime code.
 *
 * Keep sandbox implementation modules behind this export surface so callers use
 * the same config, backend, Docker, SSH, filesystem, and policy contracts.
 */
export { resolveSandboxConfigForAgent, resolveSandboxScope } from "./sandbox/config.js";
export {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
} from "./sandbox/constants.js";
export { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox/context.js";
export {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  registerSandboxBackend,
  requireSandboxBackendFactory,
} from "./sandbox/backend.js";

export { isDockerDaemonUnavailable } from "./sandbox/docker.js";
export {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
  type SandboxBrowserInfo,
  type SandboxContainerInfo,
} from "./sandbox/manage.js";
export { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";

export { isToolAllowed } from "./sandbox/tool-policy.js";
export type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./sandbox/fs-bridge.js";
export {
  buildExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildRemoteCommand,
  buildSshSandboxArgv,
  buildValidatedExecRemoteCommand,
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
  SandboxBackendPreparedWorkdirDiscarder,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirResolver,
  SandboxBackendWorkdirValidator,
} from "./sandbox/backend.js";
export type { RemoteShellSandboxHandle } from "./sandbox/remote-fs-bridge.js";
export type {
  RunSshSandboxCommandParams,
  SshSandboxSession,
  SshSandboxSettings,
} from "./sandbox/ssh.js";

export type {
  SandboxContext,
  SandboxSshConfig,
  SandboxToolPolicy,
  SandboxWorkspaceAccess,
} from "./sandbox/types.js";
