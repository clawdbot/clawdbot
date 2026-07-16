// Shared root plugin-sdk surface.
// Keep this entry intentionally tiny. Channel/provider helpers belong on
// dedicated subpaths or, for legacy consumers, the compat surface.

export type {
  ChannelAccountSnapshot,
  ChannelAgentTool,
  ChannelMessageActionAdapter,
} from "../channels/plugins/types.public.js";
export type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
export type { ChannelConfigSchema } from "../channels/plugins/types.config.js";
export type { ChannelSetupInput } from "../channels/plugins/types.public.js";
export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";

export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";

export type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
} from "../plugins/types.js";

export type { PluginRuntime } from "../plugins/runtime/types.js";

export type { OpenClawConfig } from "../config/config.js";
/** @deprecated Use OpenClawConfig instead */
export type { OpenClawConfig as ClawdbotConfig } from "../config/config.js";

export type { SecretInput } from "../config/types.secrets.js";
export type { RuntimeEnv } from "../runtime.js";

export type { ReplyPayload } from "./reply-payload.js";
export type { WizardPrompter } from "../wizard/prompts.js";

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/string-enum.js";
export { assertContextEngineHostSupport } from "../context-engine/host-compat.js";
export {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "../context-engine/delegate.js";
export { registerContextEngine } from "../context-engine/registry.js";
export {
  ContextEngineRuntimeSettingsUnavailableError,
  ContextEngineRuntimeSettingsUnsupportedError,
} from "../context-engine/types.js";
export { onDiagnosticEvent } from "../infra/diagnostic-events.js";
/** @deprecated Use OpenClawConfig instead */
export type { OpenClawConfig as OpenClawSchemaType } from "../config/config.js";
