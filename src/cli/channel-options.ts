import { uniqueStrings } from "../shared/string-normalization.js";
import { readCliStartupMetadata } from "./startup-metadata.js";

function dedupe(values: string[]): string[] {
  return uniqueStrings(values.filter(Boolean));
}

let precomputedChannelOptions: string[] | null | undefined;

function loadPrecomputedChannelOptions(): string[] | null {
  if (precomputedChannelOptions !== undefined) {
    return precomputedChannelOptions;
  }
  try {
    const parsed = readCliStartupMetadata(import.meta.url) as { channelOptions?: unknown } | null;
    if (parsed && Array.isArray(parsed.channelOptions)) {
      precomputedChannelOptions = dedupe(
        parsed.channelOptions.filter((value): value is string => typeof value === "string"),
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

export const testing = {
  resetPrecomputedChannelOptionsForTests(): void {
    precomputedChannelOptions = undefined;
  },
};
export { testing as __testing };
