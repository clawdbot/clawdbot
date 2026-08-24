/**
 * Public SDK type surface for CLI backend plugins and watchdog defaults.
 */
export type {
  CliBackendAuthEpochMode,
  CliBackendConfig,
  CliBackendExecute,
  CliBackendExecuteContext,
  CliBackendExecutionMode,
  CliBackendJsonlUsage,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionCloseReason,
  CliBackendLiveSessionHandle,
  CliBackendNormalizeConfigContext,
  CliBackendNativeToolMode,
  CliBackendParseJsonlEvent,
  CliBackendParseJsonlEventContext,
  CliBackendParsedJsonlEvent,
  CliBackendPlugin,
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
  CliBackendResolveExecutionArgs,
  CliBackendResolveExecutionArgsContext,
  CliBackendSideQuestionToolMode,
  CliBackendToolAvailability,
  CliBackendToolAvailabilityEnforcement,
  CliBackendToolPermissionRequest,
  CliBackendToolPermissionResult,
  CliBackendThinkingLevel,
} from "../plugins/cli-backend.types.js";
export type { CliBackendRuntimeArtifactPolicy } from "../plugins/cli-backend.types.js";
export { CliBackendAuthProfilePreparationError } from "../plugins/cli-backend-errors.js";
export {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "../agents/cli-watchdog-defaults.js";
