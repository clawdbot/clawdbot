// Builds message body text from session state and reply metadata.
import type { SessionEntry } from "../../config/sessions/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { setAbortMemory } from "./abort-primitives.js";

const sessionStoreRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/store.runtime.js"),
);

function loadSessionStoreRuntime() {
  return sessionStoreRuntimeLoader.load();
}

/** Applies one-shot session hints to the agent-visible body and clears consumed flags. */
export async function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  sessionEntry?: SessionEntry;
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
    if (params.sessionEntry && params.sessionStore && params.sessionKey) {
      params.sessionEntry.abortedLastRun = false;
      params.sessionEntry.updatedAt = Date.now();
      params.sessionStore[params.sessionKey] = params.sessionEntry;
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        const { updateSessionStore } = await loadSessionStoreRuntime();
        await updateSessionStore(params.storePath, (store) => {
          const entry = store[sessionKey] ?? params.sessionEntry;
          if (!entry) {
            return;
          }
          store[sessionKey] = {
            ...entry,
            abortedLastRun: false,
            updatedAt: Date.now(),
          };
        });
      }
    } else if (params.abortKey) {
      setAbortMemory(params.abortKey, false);
    }
  }

  return prefixedBodyBase;
}
