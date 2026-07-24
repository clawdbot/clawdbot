import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

type ChannelEntryIdentity = {
  id: string;
  meta: {
    aliases?: readonly string[];
  };
};

/**
 * Canonical ids own collisions with aliases so every channel setup surface
 * resolves the same user input to the same plugin.
 */
export function findChannelEntryByIdOrAlias<T extends ChannelEntryIdentity>(
  entries: readonly T[],
  raw: string,
): T | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return undefined;
  }
  return (
    entries.find((entry) => normalizeOptionalLowercaseString(entry.id) === normalized) ??
    entries.find((entry) =>
      (entry.meta.aliases ?? []).some(
        (alias) => normalizeOptionalLowercaseString(alias) === normalized,
      ),
    )
  );
}
