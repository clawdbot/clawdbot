/**
 * Public SDK type surface for CLI backend plugins and watchdog defaults.
 */
export type {
  CliBackendAuthEpochMode,
  CliBackendConfig,
  CliBackendExecutionMode,
  CliBackendJsonlUsage,
  CliBackendLiveSessionRequirement,
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
  CliBackendThinkingLevel,
} from "../plugins/types.js";
export type { CliBackendRuntimeArtifactPolicy } from "../plugins/cli-backend.types.js";
export { CliBackendAuthProfilePreparationError } from "../plugins/cli-backend-errors.js";
export {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "../agents/cli-watchdog-defaults.js";
