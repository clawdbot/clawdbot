// Private ACPX runtime backend helpers for bundled extensions.
// Keep this surface narrow and limited to the ACP runtime/backend contract.

export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export { AcpRuntimeError } from "../acp/runtime/errors.js";
export { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpSessionUpdateTag,
} from "../acp/runtime/types.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../plugins/types.js";
export type {
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "./windows-spawn.js";
export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "./windows-spawn.js";
export {
  listKnownProviderAuthEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "../secrets/provider-env-vars.js";
