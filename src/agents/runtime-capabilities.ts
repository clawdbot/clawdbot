import { resolveChannelCapabilities } from "../config/channel-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveChannelPromptCapabilities } from "./channel-tools.js";

export function mergeRuntimeCapabilities(
  base?: readonly string[] | null,
  additions: readonly string[] = [],
): string[] | undefined {
  const merged = [...(base ?? [])];
  const seen = new Set(
    merged.map((capability) => normalizeOptionalLowercaseString(capability)).filter(Boolean),
  );

  for (const capability of additions) {
    const normalizedCapability = normalizeOptionalLowercaseString(capability);
    if (!normalizedCapability || seen.has(normalizedCapability)) {
      continue;
    }
    seen.add(normalizedCapability);
    merged.push(capability);
  }

  return merged.length > 0 ? merged : undefined;
}

export function collectRuntimeChannelCapabilities(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  if (!params.channel) {
    return undefined;
  }
  return mergeRuntimeCapabilities(
    resolveChannelCapabilities(params),
    params.cfg ? resolveChannelPromptCapabilities(params) : [],
  );
}
