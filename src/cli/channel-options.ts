// CLI channel option formatter backed by generated startup metadata when available.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { readCliStartupMetadata } from "./startup-metadata.js";

function loadPrecomputedChannelOptions(): string[] | null {
  try {
    const parsed = readCliStartupMetadata(import.meta.url) as { channelOptions?: unknown } | null;
    if (parsed && Array.isArray(parsed.channelOptions)) {
      return uniqueStrings(
        parsed.channelOptions.filter(
          (value): value is string => typeof value === "string" && Boolean(value),
        ),
      );
    }
  } catch {
    // Source checkouts may not have generated startup metadata yet.
  }
  return null;
}

export function resolveCliChannelOptions(): string[] {
  const precomputed = loadPrecomputedChannelOptions();
  return precomputed ?? [];
}

export function formatCliChannelOptions(extra: string[] = []): string {
  const options = [...extra, ...resolveCliChannelOptions()];
  return options.length > 0 ? options.join("|") : "channel";
}
