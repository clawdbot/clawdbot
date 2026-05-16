import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasInternalHookListeners,
  triggerInternalHook,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
} from "../hooks/internal-hooks.js";
import type { SessionsPatchParams } from "./protocol/index.js";

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
