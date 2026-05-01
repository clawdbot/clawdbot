export { basenameLower, normalizeExecutableToken } from "./exec-wrapper-tokens.js";
export {
  extractEnvAssignmentKeysFromDispatchWrappers,
  isDispatchWrapperExecutable,
  resolveDispatchWrapperTrustPlan,
  unwrapDispatchWrappersForResolution,
  unwrapEnvInvocation,
  unwrapKnownDispatchWrapperInvocation,
} from "./dispatch-wrapper-resolution.js";
export {
  extractShellWrapperCommand,
  extractShellWrapperInlineCommand,
  hasEnvManipulationBeforeShellWrapper,
  isShellWrapperExecutable,
  isShellWrapperInvocation,
  POSIX_SHELL_WRAPPERS,
  POWERSHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
  unwrapKnownShellMultiplexerInvocation,
} from "./shell-wrapper-resolution.js";
