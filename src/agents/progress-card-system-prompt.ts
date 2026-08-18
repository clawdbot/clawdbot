import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasPairedCardRenderer } from "../infra/device-pairing.js";
import { resolveUtilityModelRefForAgent } from "./utility-model.js";

const PROGRESS_CARD_SYSTEM_PROMPT =
  "During multi-step work, keep your progress card current with the progress_card tool; the user follows it instead of reading the transcript.";

function isAgentMainSession(params: {
  agentId: string;
  config?: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  if (!params.sessionKey) {
    return true;
  }
  const canonicalSessionKey = canonicalizeMainSessionAlias({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const canonicalMainSessionKey = canonicalizeMainSessionAlias({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: resolveAgentMainSessionKey({ cfg: params.config, agentId: params.agentId }),
  });
  return canonicalSessionKey === canonicalMainSessionKey;
}

/**
 * Pairing may change between sessions and embedded attempts because this fragment
 * sits below the prompt-cache boundary. Codex pins developer instructions at
 * thread creation, so a mid-session pairing change reaches its next thread.
 */
export async function appendProgressCardSystemPrompt(params: {
  agentId: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  extraSystemPrompt?: string;
  modelId: string;
  provider: string;
  sessionKey?: string;
}): Promise<string | undefined> {
  if (isAgentMainSession(params) || !(await hasPairedCardRenderer())) {
    return params.extraSystemPrompt;
  }
  const provider = params.provider.trim().toLowerCase();
  const modelId = params.modelId.trim();
  const authProfileId = params.authProfileId?.trim();
  const modelRef = `${provider}/${modelId}${authProfileId ? `@${authProfileId}` : ""}`;
  const utilityModelRef = resolveUtilityModelRefForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
    primaryProvider: provider,
    primaryModelRef: modelRef,
  });
  if (utilityModelRef === modelRef) {
    return params.extraSystemPrompt;
  }
  const existing = params.extraSystemPrompt?.trim();
  return existing ? `${existing}\n\n${PROGRESS_CARD_SYSTEM_PROMPT}` : PROGRESS_CARD_SYSTEM_PROMPT;
}
