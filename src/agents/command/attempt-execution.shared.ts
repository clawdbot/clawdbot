/**
 * Shared session persistence and prompt-body helpers for agent attempt
 * execution paths.
 */
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
} from "../internal-events.js";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../internal-runtime-context.js";
import type { AgentCommandOpts } from "./types.js";

/** Parameters for merging and persisting a session entry update. */
type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  initialEntry: SessionEntry;
  entry: SessionEntry;
  shouldPersist?: (entry: SessionEntry | undefined) => boolean;
};

/** Persists one session entry while keeping the caller's in-memory store aligned. */
export async function persistSessionEntry(
  params: PersistSessionEntryParams,
): Promise<SessionEntry | undefined> {
  let rejectedMissingEntry = false;
  const persisted = await patchSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      const shouldPersistCurrent = params.shouldPersist?.(context.existingEntry);
      if (!context.existingEntry && shouldPersistCurrent !== true) {
        rejectedMissingEntry = true;
        return null;
      }
      if (shouldPersistCurrent === false) {
        rejectedMissingEntry = !context.existingEntry;
        return null;
      }
      if (!context.existingEntry) {
        return params.entry;
      }
      if (context.existingEntry.sessionId !== params.initialEntry.sessionId) {
        return null;
      }
      // Agent turns persist broad snapshots. Project only this turn's changes
      // so a stale snapshot cannot restore fields changed or cleared meanwhile.
      return mergeSessionSnapshotChanges({
        initial: params.initialEntry,
        next: params.entry,
        current: context.existingEntry,
      });
    },
    {
      fallbackEntry: params.sessionStore[params.sessionKey] ?? params.entry,
      replaceEntry: true,
    },
  );
  if (rejectedMissingEntry) {
    delete params.sessionStore[params.sessionKey];
    return undefined;
  }
  if (persisted) {
    params.sessionStore[params.sessionKey] = persisted;
  } else {
    delete params.sessionStore[params.sessionKey];
  }
  return persisted ?? undefined;
}

/** Prepends hidden internal event context unless the body already carries it. */
export function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (hasInternalRuntimeContext(body)) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

// ACP/plain transcript bodies cannot carry internal runtime context markup, so
// render events as visible plain text before stripping hidden sections.
function resolvePlainInternalEventBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  const renderedEvents = formatAgentInternalEventsForPlainPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  const visibleBody = stripInternalRuntimeContext(body).trim();
  return [renderedEvents, visibleBody].filter(Boolean).join("\n\n") || body;
}

/** Resolves the prompt body submitted to ACP runtimes. */
export function resolveAcpPromptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  return events?.length ? resolvePlainInternalEventBody(body, events) : body;
}

/** Resolves the body stored in transcripts after internal event rendering. */
export function resolveInternalEventTranscriptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (!hasInternalRuntimeContext(body)) {
    return body;
  }
  return resolvePlainInternalEventBody(body, events);
}
