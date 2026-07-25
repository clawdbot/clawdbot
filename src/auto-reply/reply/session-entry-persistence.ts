// Atomic persistence for broad auto-reply session snapshots.
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  mergeSessionSnapshotChanges,
  sessionSnapshotTouchedFieldsConflict,
} from "../../config/sessions/session-snapshot-merge.js";

type PersistReplySessionEntryParams = {
  allowCreate?: boolean;
  entry: SessionEntry;
  initialEntry: SessionEntry;
  reassertLiveModelSwitchPending?: boolean;
  sessionKey: string;
  skipMaintenance?: boolean;
  storePath: string;
  touchedFields?: ReadonlyArray<keyof SessionEntry>;
};

type PersistReplySessionEntryResult =
  | { status: "current"; entry: SessionEntry }
  | { status: "lifecycle-invalidated"; error: string; entry?: SessionEntry };

/** Persists reply-owned state without reverting concurrent session management. */
export async function persistReplySessionEntry(
  params: PersistReplySessionEntryParams,
): Promise<PersistReplySessionEntryResult> {
  let lifecycleError: string | undefined;
  let lifecycleEntry: SessionEntry | undefined;
  const persisted = await patchSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      if (!context.existingEntry) {
        if (params.allowCreate !== true) {
          lifecycleError = resolveSessionWorkStartError(params.sessionKey, undefined, {
            expectedSessionId: params.initialEntry.sessionId,
          });
          return null;
        }
        return params.entry;
      }
      lifecycleError = resolveSessionWorkStartError(params.sessionKey, context.existingEntry, {
        expectedSessionId: params.initialEntry.sessionId,
      });
      if (lifecycleError) {
        lifecycleEntry = context.existingEntry;
        return null;
      }
      if (
        sessionSnapshotTouchedFieldsConflict({
          initial: params.initialEntry,
          next: params.entry,
          current: context.existingEntry,
          touchedFields: params.touchedFields,
        })
      ) {
        return null;
      }
      // Reply flows persist broad snapshots. Project only reply-owned changes
      // so concurrent lifecycle, policy, and privacy updates remain authoritative.
      return mergeSessionSnapshotChanges({
        initial: params.initialEntry,
        next: params.entry,
        current: context.existingEntry,
        reassertLiveModelSwitchPending: params.reassertLiveModelSwitchPending,
      });
    },
    {
      fallbackEntry: params.entry,
      replaceEntry: true,
      skipMaintenance: params.skipMaintenance,
    },
  );
  if (lifecycleError) {
    return {
      status: "lifecycle-invalidated",
      error: lifecycleError,
      ...(lifecycleEntry ? { entry: lifecycleEntry } : {}),
    };
  }
  if (!persisted) {
    return {
      status: "lifecycle-invalidated",
      error: `Session "${params.sessionKey}" changed while starting work. Retry.`,
    };
  }
  return { status: "current", entry: persisted };
}
