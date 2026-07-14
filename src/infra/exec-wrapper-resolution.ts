// Wrapper resolution facade for executable tokens, dispatch wrappers, and shell
// multiplexers used by exec approval policy.
export { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
export {
  extractEnvAssignmentKeysFromDispatchWrappers,
  unwrapDispatchWrappersForResolution,
  unwrapKnownDispatchWrapperInvocation,
} from "./dispatch-wrapper-resolution.js";
export {
  extractBindableShellWrapperInlineCommand,
  extractShellWrapperCommand,
  hasEnvManipulationBeforeShellWrapper,
  isBlockedShellWrapperCommand,
  isShellWrapperExecutable,
  isShellWrapperInvocation,
  POSIX_SHELL_WRAPPERS,
  POWERSHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
  unwrapKnownShellMultiplexerInvocation,
} from "./shell-wrapper-resolution.js";
