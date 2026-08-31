// Session patch hook dispatcher.
// Publishes internal mutation notifications after Gateway session patch calls.
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasInternalHookListeners,
  triggerInternalHook,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
} from "../hooks/internal-hooks.js";

// Session patch hooks are fire-and-forget internal hooks. The context is cloned
// so hook listeners cannot mutate the live session entry or patch object.
/** Triggers internal session patch hooks when listeners are registered. */
export function triggerSessionPatchHook(params: {
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry;
  sessionKey: string;
  patch: SessionsPatchParams;
}): void {
  if (!hasInternalHookListeners("session", "patch")) {
    return;
  }

  const hookContext: SessionPatchHookContext = structuredClone({
    sessionEntry: params.sessionEntry,
    patch: params.patch,
    cfg: params.cfg,
  });
  const hookEvent: SessionPatchHookEvent = {
    type: "session",
    action: "patch",
    sessionKey: params.sessionKey,
    context: hookContext,
    timestamp: new Date(),
    messages: [],
  };
  void triggerInternalHook(hookEvent);
}
