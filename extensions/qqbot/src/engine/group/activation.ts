// Qqbot plugin module implements activation behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeGroupActivation,
  type GroupActivationMode,
} from "openclaw/plugin-sdk/group-activation";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

export type { GroupActivationMode } from "openclaw/plugin-sdk/group-activation";

export function resolveGroupActivation(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
}): GroupActivationMode {
  const fallback: GroupActivationMode = params.configRequireMention ? "mention" : "always";

  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const activation = normalizeGroupActivation(
      getSessionEntry({
        storePath,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      })?.groupActivation,
    );
    return activation ?? fallback;
  } catch {
    return fallback;
  }
}
