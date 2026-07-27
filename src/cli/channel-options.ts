// CLI channel option formatter backed by generated startup metadata when available.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { readCliStartupMetadata } from "./startup-metadata.js";

let precomputedChannelOptions: string[] | null | undefined;

function loadPrecomputedChannelOptions(): string[] | null {
  if (precomputedChannelOptions !== undefined) {
    return precomputedChannelOptions;
  }
  try {
    const parsed = readCliStartupMetadata(import.meta.url) as { channelOptions?: unknown } | null;
    if (parsed && Array.isArray(parsed.channelOptions)) {
      precomputedChannelOptions = uniqueStrings(
        parsed.channelOptions.filter(
          (value): value is string => typeof value === "string" && Boolean(value),
        ),
      );
      return precomputedChannelOptions;
    }
  } catch {
    // Source checkouts may not have generated startup metadata yet.
  }
  precomputedChannelOptions = null;
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

const testing = {
  resetPrecomputedChannelOptionsForTests(): void {
    precomputedChannelOptions = undefined;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliChannelOptionsTestApi")] =
    testing;
}
