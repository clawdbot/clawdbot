import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveChannelApprovalCapability } from "./approvals.js";
import type { ChannelPlugin } from "./types.plugin.js";

export const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY = "nativeApprovals";

const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY_NORMALIZED = "nativeapprovals";

// Keep prompt construction lightweight. Full plugin loading is too expensive on
// prompt-only import paths; plugin-backed checks still cover loaded native
// channels at runtime.
const KNOWN_NATIVE_APPROVAL_PROMPT_CHANNELS = new Set([
  "discord",
  "matrix",
  "qqbot",
  "slack",
  "telegram",
]);

export function channelPluginHasNativeApprovalPromptUi(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): boolean {
  const capability = resolveChannelApprovalCapability(plugin);
  return Boolean(capability?.native || capability?.nativeRuntime);
}

export function isKnownNativeApprovalPromptChannel(channel?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(channel);
  return Boolean(normalized && KNOWN_NATIVE_APPROVAL_PROMPT_CHANNELS.has(normalized));
}

export function hasNativeApprovalPromptRuntimeCapability(
  capabilities?: readonly string[] | null,
): boolean {
  return Boolean(
    capabilities?.some(
      (capability) =>
        normalizeOptionalLowercaseString(capability) ===
        NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY_NORMALIZED,
    ),
  );
}
