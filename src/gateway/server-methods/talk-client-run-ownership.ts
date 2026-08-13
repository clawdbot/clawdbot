import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayRequestHandlers } from "./types.js";

export function hasOwnedActiveTalkClientRun(params: {
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
  clientConnId?: string;
  sessionKey: string;
}): boolean {
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return false;
  }
  for (const entry of params.context.chatAbortControllers.values()) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      return true;
    }
  }
  return false;
}
