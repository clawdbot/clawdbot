import type { RunEmbeddedAgentParams } from "./params.js";

type PromptSessionIdentitySource = Pick<
  RunEmbeddedAgentParams,
  "sessionId" | "sessionKey" | "promptSessionIdentity"
>;

/**
 * Resolves the session identity the system prompt renders. Detached helper runs
 * (for example the Skill Workshop experience review) replay a foreground
 * transcript under a private session; rendering the foreground identity keeps
 * the prompt prefix byte-identical so content-addressed provider caches reuse it.
 */
export function resolvePromptSessionIdentity(params: PromptSessionIdentitySource): {
  sessionId: string;
  sessionKey?: string;
} {
  const override = params.promptSessionIdentity;
  const sessionId = override?.sessionId?.trim() || params.sessionId;
  const sessionKey = override?.sessionKey?.trim() || params.sessionKey;
  return { sessionId, ...(sessionKey ? { sessionKey } : {}) };
}
