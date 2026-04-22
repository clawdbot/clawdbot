// Private helper surface for the bundled tlon plugin.
// Keep this list additive and scoped to the bundled Tlon surface.

import { createOptionalChannelSetupSurface } from "./channel-setup.js";

export type { ReplyPayload } from "./reply-payload.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  applyAccountNameToChannelSection,
  patchScopedAccountConfig,
} from "../channels/plugins/setup-helpers.js";
export type {
  ChannelAccountSnapshot,
  ChannelOutboundAdapter,
  ChannelSetupInput,
} from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export { createDedupeCache } from "../infra/dedupe.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export type { LookupFn, SsrFPolicy } from "../infra/net/ssrf.js";
export { isBlockedHostnameOrIp, SsrFBlockedError } from "../infra/net/ssrf.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { buildComputedAccountStatusSnapshot } from "./status-helpers.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { createLoggerBackedRuntime } from "./runtime.js";

const tlonSetup = createOptionalChannelSetupSurface({
  channel: "tlon",
  label: "Tlon",
  npmSpec: "@openclaw/tlon",
  docsPath: "/channels/tlon",
});

export const tlonSetupAdapter = tlonSetup.setupAdapter;
export const tlonSetupWizard = tlonSetup.setupWizard;
