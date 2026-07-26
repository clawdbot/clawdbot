/**
 * Public SDK type surface for CLI backend plugins and watchdog defaults.
 */
export type {
  CliBackendAuthEpochMode,
  CliBackendConfig,
  CliBackendExecutionMode,
  CliBackendNormalizeConfigContext,
  CliBackendNativeToolMode,
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
export {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "../agents/cli-watchdog-defaults.js";
