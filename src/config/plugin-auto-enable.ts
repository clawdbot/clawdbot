// Public facade for plugin auto-enable detection, application, and reason types.
export {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.apply.js";
export { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
export type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
export { resolvePluginAutoEnableCandidateReason } from "./plugin-auto-enable.shared.js";
