// Builds message body text from session state and reply metadata.
import type { SessionEntry } from "../../config/sessions/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { setAbortMemory } from "./abort-primitives.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";

const sessionAccessorRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/session-accessor.js"),
);

function loadSessionAccessorRuntime() {
  return sessionAccessorRuntimeLoader.load();
}

/** Applies one-shot session hints to the agent-visible body and clears consumed flags. */
export async function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  abortKey?: string;
}): Promise<string> {
  let prefixedBodyBase = params.baseBody;
  const abortedHint = params.abortedLastRun
    ? "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification."
    : "";
  if (abortedHint) {
    prefixedBodyBase = `${abortedHint}\n\n${prefixedBodyBase}`;
    // The abort hint is one-shot; clear durable state once it is added.
    const sessionEntry = params.sessionEntryHandle?.getCurrent() ?? params.sessionEntry;
    if (sessionEntry && params.sessionEntryHandle && params.sessionKey) {
      const updatedAt = Date.now();
      params.sessionEntryHandle.patchCurrent({
        abortedLastRun: false,
        updatedAt,
      });
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        const { patchSessionEntry } = await loadSessionAccessorRuntime();
        await patchSessionEntry(
          {
            storePath: params.storePath,
            sessionKey,
          },
          () => ({
            abortedLastRun: false,
            updatedAt,
          }),
          { fallbackEntry: params.sessionEntryHandle.getCurrent() ?? sessionEntry },
        );
      }
    } else if (sessionEntry && params.sessionStore && params.sessionKey) {
      const updatedAt = Date.now();
      sessionEntry.abortedLastRun = false;
      sessionEntry.updatedAt = updatedAt;
      params.sessionStore[params.sessionKey] = sessionEntry;
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        const { patchSessionEntry } = await loadSessionAccessorRuntime();
        await patchSessionEntry(
          {
            storePath: params.storePath,
            sessionKey,
          },
          () => ({
            abortedLastRun: false,
            updatedAt,
          }),
          { fallbackEntry: sessionEntry },
        );
      }
    } else if (params.abortKey) {
      setAbortMemory(params.abortKey, false);
    }
  }

  return prefixedBodyBase;
}
