import type { InternalHookEvent } from "../../hooks/internal-hooks.js";

export function isInternalHookEvent(value: unknown): value is InternalHookEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.sessionKey === "string" &&
    Array.isArray(candidate.messages) &&
    typeof candidate.context === "object" &&
    candidate.context !== null
  );
}
