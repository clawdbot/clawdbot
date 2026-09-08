import type { Model, ProviderReplayState } from "@openclaw/llm-core";
import { shortHash } from "../utils/hash.js";

type ProviderReplayContext = Readonly<
  Pick<
    ProviderReplayState,
    "provider" | "api" | "model" | "baseUrlHash" | "sessionHash" | "authProfileHash"
  >
>;

function hashReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

export function buildProviderReplayContext(
  model: Model,
  options?: { authProfileId?: string; sessionId?: string },
): ProviderReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashReplayContextValue(model.baseUrl),
    sessionHash: hashReplayContextValue(options?.sessionId),
    authProfileHash: hashReplayContextValue(options?.authProfileId),
  };
}

export function providerReplayContextMatches(
  state: ProviderReplayContext,
  context: ProviderReplayContext,
): boolean {
  // Replay state must stay fenced to its exact provider, model, endpoint, session, and auth identity.
  return (
    state.provider === context.provider &&
    state.api === context.api &&
    state.model === context.model &&
    state.baseUrlHash === context.baseUrlHash &&
    state.sessionHash === context.sessionHash &&
    state.authProfileHash === context.authProfileHash
  );
}
