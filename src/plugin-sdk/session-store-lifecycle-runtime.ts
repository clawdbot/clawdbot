import { randomUUID } from "node:crypto";
import {
  resolveSessionFilePathCore as resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionStorePathCore as resolveStorePath,
} from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  patchSessionEntryCore as patchSessionEntry,
  resetSessionEntryLifecycle as resetAccessorSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";

export type ResetSessionEntryLifecycleParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  expectedSessionId?: string;
  expectedUpdatedAt?: number;
  sessionKey: string;
  storePath?: string;
  /** Internal owner hook used by plugin runtime wrappers for locked harness sessions. */
  releasePhysicalOwner?: (context: {
    agentId?: string;
    entry: SessionEntry;
    reason: "reset";
    sessionFile?: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => Promise<void> | void;
  update: (
    entry: SessionEntry,
    context: { nextSessionFile: string; nextSessionId: string },
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
};

type InternalResetSessionEntryLifecycleParams = ResetSessionEntryLifecycleParams & {
  /** Owner-bound assertion intentionally absent from the plugin-facing runtime contract. */
  assertActiveOwner?: () => void;
};

class SessionLifecycleResetSkipped extends Error {
  constructor() {
    super("session lifecycle reset skipped");
    this.name = "SessionLifecycleResetSkipped";
  }
}

async function publishReleasedOwnerReplacement(params: {
  agentId?: string;
  expectedReservedEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
  resolveNextSessionFile: (
    sessionId: string,
    options?: { agentId?: string; sessionsDir?: string },
  ) => string;
}): Promise<boolean> {
  const current = loadSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
  if (
    !current ||
    current.sessionId !== params.expectedReservedEntry.sessionId ||
    current.lifecycleRevision !== params.expectedReservedEntry.lifecycleRevision
  ) {
    // A different identity or lifecycle generation owns the newer state. Never
    // overwrite it merely to clean up this failed lifecycle transaction.
    return false;
  }
  const nextSessionId = randomUUID();
  const nextSessionFile = params.resolveNextSessionFile(
    nextSessionId,
    resolveSessionFilePathOptions({
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      storePath: params.storePath,
    }),
  );
  try {
    await resetAccessorSessionEntryLifecycle({
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      storePath: params.storePath,
      target: { canonicalKey: params.sessionKey, storeKeys: [params.sessionKey] },
      buildNextEntry: ({ currentEntry }) => {
        if (
          !currentEntry ||
          currentEntry.sessionId !== params.expectedReservedEntry.sessionId ||
          currentEntry.lifecycleRevision !== params.expectedReservedEntry.lifecycleRevision
        ) {
          throw new SessionLifecycleResetSkipped();
        }
        // The physical harness is already gone. Publish a minimal fresh row so
        // no persisted lock or harness identity claims ownership of that session.
        return {
          sessionFile: nextSessionFile,
          sessionId: nextSessionId,
          updatedAt: Date.now(),
        };
      },
    });
    return true;
  } catch (error) {
    if (error instanceof SessionLifecycleResetSkipped) {
      return false;
    }
    throw error;
  }
}

export async function resetSessionEntryLifecycleImpl(
  params: ResetSessionEntryLifecycleParams,
  resolveNextSessionFile: (
    sessionId: string,
    options?: { agentId?: string; sessionsDir?: string },
  ) => string,
): Promise<SessionEntry | null> {
  const internalParams = params as InternalResetSessionEntryLifecycleParams;
  const storePath =
    params.storePath ??
    resolveStorePath(undefined, {
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      ...(params.env !== undefined ? { env: params.env } : {}),
    });
  const snapshot = loadSessionEntry({ sessionKey: params.sessionKey, storePath });
  const expectedSessionId = params.expectedSessionId ?? snapshot?.sessionId;
  const expectedUpdatedAt = params.expectedUpdatedAt ?? snapshot?.updatedAt;
  if (!expectedSessionId) {
    return null;
  }

  const identities = [params.sessionKey, expectedSessionId];
  const resetReservationRevision = `reset:${randomUUID()}`;
  let skipped = false;
  let resultEntry: SessionEntry | null = null;
  let originalEntry: SessionEntry | undefined;
  let reservedEntry: SessionEntry | undefined;

  await runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities,
    prepare: async () => {
      const current = loadSessionEntry({ sessionKey: params.sessionKey, storePath });
      if (
        !current ||
        current.sessionId !== expectedSessionId ||
        (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)
      ) {
        skipped = true;
        return;
      }
      try {
        const reserved = await patchSessionEntry(
          { sessionKey: params.sessionKey, storePath },
          (currentEntry) => {
            if (
              currentEntry.sessionId !== expectedSessionId ||
              (expectedUpdatedAt !== undefined && currentEntry.updatedAt !== expectedUpdatedAt)
            ) {
              throw new SessionLifecycleResetSkipped();
            }
            originalEntry = structuredClone(currentEntry);
            // Persist the removal boundary before awaited drain/owner work. If
            // reset later fails, new work cannot reuse the old transcript.
            return { initializationPending: true, lifecycleRevision: resetReservationRevision };
          },
          { preserveActivity: true, requireWriteSuccess: true },
        );
        if (!reserved || !originalEntry) {
          throw new SessionLifecycleResetSkipped();
        }
        reservedEntry = loadSessionEntry({ sessionKey: params.sessionKey, storePath });
        if (!reservedEntry) {
          throw new SessionLifecycleResetSkipped();
        }
      } catch (error) {
        if (error instanceof SessionLifecycleResetSkipped) {
          skipped = true;
          return;
        }
        throw error;
      }
      const drained = await interruptSessionWorkAdmissions({
        scope: storePath,
        identities,
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
      if (!drained) {
        throw new Error(
          `timed out draining work before session lifecycle reset: ${params.sessionKey}`,
        );
      }
    },
    run: async () => {
      if (skipped) {
        return;
      }
      if (!originalEntry || !reservedEntry) {
        throw new Error(`session lifecycle reset lost its durable boundary: ${params.sessionKey}`);
      }
      let physicalOwnerReleased = false;
      try {
        if (reservedEntry.modelSelectionLocked === true && reservedEntry.agentHarnessId?.trim()) {
          if (!params.releasePhysicalOwner) {
            throw new Error(
              `locked harness-owned session requires physical owner release before lifecycle reset: ${params.sessionKey}`,
            );
          }
          const sessionFile =
            "sessionFile" in originalEntry && typeof originalEntry.sessionFile === "string"
              ? originalEntry.sessionFile
              : undefined;
          internalParams.assertActiveOwner?.();
          await params.releasePhysicalOwner({
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            entry: structuredClone(originalEntry),
            reason: "reset",
            ...(sessionFile ? { sessionFile } : {}),
            sessionId: expectedSessionId,
            sessionKey: params.sessionKey,
            storePath,
          });
          physicalOwnerReleased = true;
        }
        const accessorParams: Parameters<typeof resetAccessorSessionEntryLifecycle>[0] & {
          beforeEntryMutation?: () => void;
        } = {
          ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
          storePath,
          target: { canonicalKey: params.sessionKey, storeKeys: [params.sessionKey] },
          ...(internalParams.assertActiveOwner
            ? { beforeEntryMutation: internalParams.assertActiveOwner }
            : {}),
          buildNextEntry: async ({ currentEntry }) => {
            if (
              !currentEntry ||
              currentEntry.sessionId !== expectedSessionId ||
              currentEntry.lifecycleRevision !== resetReservationRevision ||
              (expectedUpdatedAt !== undefined && currentEntry.updatedAt !== expectedUpdatedAt)
            ) {
              throw new SessionLifecycleResetSkipped();
            }
            const nextSessionId = randomUUID();
            const nextSessionFile = resolveNextSessionFile(
              nextSessionId,
              resolveSessionFilePathOptions({
                ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                storePath,
              }),
            );
            const patch = await params.update(currentEntry, { nextSessionFile, nextSessionId });
            if (!patch) {
              throw new SessionLifecycleResetSkipped();
            }
            return {
              ...patch,
              initializationPending: undefined,
              lifecycleRevision: undefined,
              sessionFile: nextSessionFile,
              sessionId: nextSessionId,
              updatedAt: patch.updatedAt ?? Date.now(),
            };
          },
        };
        const result = await resetAccessorSessionEntryLifecycle(accessorParams);
        resultEntry = result.nextEntry;
      } catch (err) {
        if (err instanceof SessionLifecycleResetSkipped) {
          if (physicalOwnerReleased && reservedEntry) {
            await publishReleasedOwnerReplacement({
              ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
              expectedReservedEntry: reservedEntry,
              sessionKey: params.sessionKey,
              storePath,
              resolveNextSessionFile,
            });
            throw new Error(
              `session lifecycle reset skipped after physical owner release: ${params.sessionKey}`,
              { cause: err },
            );
          }
          throw new Error(
            `session lifecycle reset skipped after durable boundary: ${params.sessionKey}`,
            { cause: err },
          );
        }
        if (physicalOwnerReleased && reservedEntry) {
          await publishReleasedOwnerReplacement({
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            expectedReservedEntry: reservedEntry,
            sessionKey: params.sessionKey,
            storePath,
            resolveNextSessionFile,
          });
        }
        throw err;
      }
    },
  });

  return resultEntry;
}

/** Internal runtime entry point; plugin callers receive an owner-scoped wrapper. */
export async function resetPluginRuntimeSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<SessionEntry | null> {
  return await resetSessionEntryLifecycleImpl(params, (sessionId, options) =>
    resolveSessionFilePath(sessionId, undefined, options),
  );
}
