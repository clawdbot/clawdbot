/**
 * Extension-safe session SDK surface.
 *
 * Keep this barrel free of the session runtime and resource loader. The
 * extension loader imports it to virtualize `openclaw/plugin-sdk/agent-sessions`,
 * so importing loader-owned modules here creates runtime cycles.
 */

export { getAgentDir, VERSION } from "../config.js";
export * from "./auth-storage.js";
export * from "./bash-executor.js";
export * from "./compaction/index.js";
export * from "./event-bus.js";
export type { ReadonlyFooterDataProvider } from "./footer-data-provider.js";
export { convertToLlm } from "./messages.js";
export * from "./model-registry.js";
export * from "./model-resolver.js";
export * from "./package-manager.js";
export type { PromptTemplate } from "./prompt-templates.js";
export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.js";
export * from "./session-manager.js";
export {
  FileSettingsStorage,
  InMemorySettingsStorage,
  SettingsManager,
  type BranchSummarySettings,
  type ImageSettings,
  type MarkdownSettings,
  type PackageSource,
  type ProviderRetrySettings,
  type RetrySettings,
  type Settings,
  type SettingsError,
  type SettingsScope,
  type SettingsStorage,
  type TerminalSettings,
  type ThinkingBudgetsSettings,
  type TransportSetting,
  type WarningSettings,
} from "./settings-manager.js";
export type { Skill } from "../../skills/loading/session.js";
export * from "./source-info.js";
export * from "./tools/index.js";
export type * from "./extensions/types.js";
export {
  defineTool,
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isToolCallEventType,
  isWriteToolResult,
} from "./extensions/types.js";
export { wrapRegisteredTool, wrapRegisteredTools } from "./extensions/wrapper.js";
