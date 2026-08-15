/**
 * Native approval prompt capability helpers.
 *
 * Detects loaded or known channels that can render approval prompts natively.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listBundledChannelCatalogEntries } from "../bundled-channel-catalog-read.js";
import { resolveChannelApprovalCapability } from "./approvals.js";
import type { ChannelPlugin } from "./types.plugin.js";

export const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY = "nativeApprovals";

const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY_NORMALIZED = "nativeapprovals";

export function channelPluginHasNativeApprovalPromptUi(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): boolean {
  const capability = resolveChannelApprovalCapability(plugin);
  return Boolean(capability?.native || capability?.nativeRuntime);
}

export function isKnownNativeApprovalPromptChannel(channel?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(channel);
  return Boolean(
    normalized &&
    listBundledChannelCatalogEntries().some(
      (entry) => entry.id === normalized && entry.channel.approvalFlags?.includes("native"),
    ),
  );
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
