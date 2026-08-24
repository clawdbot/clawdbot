import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntryBatchProjectionUpdate } from "./session-accessor.sqlite-contract.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import type { SessionEntry } from "./types.js";

/** Compatibility adapter for the shipped detached-store projection. */
export async function applySessionEntryBatchProjection<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  sessionKeys?: readonly string[];
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    store: Record<string, SessionEntry>,
  ) => Promise<SessionEntryBatchProjectionUpdate<T>> | SessionEntryBatchProjectionUpdate<T>;
}): Promise<T> {
  return await applySessionEntryCanonicalReplacements({
    ...params,
    update: async (entries) => {
      const store = Object.fromEntries(
        entries.flatMap(({ entry, sessionKey }) =>
          isInternalSessionEffectsKey(sessionKey) ? [] : [[sessionKey, entry] as const],
        ),
      );
      const operation = await params.update(store);
      return {
        result: operation.result,
        replacements: [...(operation.mutations ?? [])].map((mutation) => ({
          entry: mutation.entry,
          previousSessionKeys: mutation.previousSessionKeys ?? [],
          sessionKey: mutation.sessionKey,
        })),
      };
    },
  });
}
