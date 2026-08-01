import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

export function shouldPreserveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  currentProvider: string;
  provider: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): boolean {
  const profileOverride = normalizeOptionalString(params.entry.authProfileOverride);
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (!profileOverride || !provider) {
    return false;
  }
  const resolvesToTargetProvider = (rawProvider: string | undefined): boolean => {
    const candidate = normalizeOptionalLowercaseString(rawProvider);
    const lookupParams = {
      config: params.cfg,
      ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    };
    return Boolean(
      candidate &&
      resolveProviderIdForAuth(candidate, lookupParams) ===
        resolveProviderIdForAuth(provider, lookupParams),
    );
  };
  const delimiterIndex = profileOverride.indexOf(":");
  if (delimiterIndex < 0) {
    return resolvesToTargetProvider(params.currentProvider);
  }
  return resolvesToTargetProvider(profileOverride.slice(0, delimiterIndex));
}
