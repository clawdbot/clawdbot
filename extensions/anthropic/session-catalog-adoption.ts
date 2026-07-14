import { createHash } from "node:crypto";

export const CLAUDE_LOCAL_SESSION_HOST_ID = "gateway:local";
const CLAUDE_ADOPTED_SESSION_KEY_PREFIX = "plugin:anthropic:catalog-adopt:claude:";

export function adoptedSourceKey(hostId: string, threadId: string): string {
  return `${hostId}\0${threadId}`;
}

export function adoptedSessionKey(hostId: string, threadId: string): string {
  // Local rows hash threadId alone: adopted keys minted before node support
  // must stay stable, or existing adopted sessions would orphan/duplicate.
  const source =
    hostId === CLAUDE_LOCAL_SESSION_HOST_ID ? threadId : adoptedSourceKey(hostId, threadId);
  return `${CLAUDE_ADOPTED_SESSION_KEY_PREFIX}${createHash("sha256").update(source).digest("hex")}`;
}
