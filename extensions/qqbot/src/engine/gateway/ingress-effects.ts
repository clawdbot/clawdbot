import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createIngressEffectOnce } from "openclaw/plugin-sdk/ingress-effect-once";
import { QQBOT_INGRESS_COMPLETED_MAX_ENTRIES, QQBOT_INGRESS_COMPLETED_TTL_MS } from "./ingress.js";
import type { EngineLogger } from "./types.js";

export type QQBotIngressEffectOnce = ReturnType<typeof createIngressEffectOnce>;

export function createQQBotIngressEffectOnce(params: {
  accountId: string;
  log?: EngineLogger;
}): QQBotIngressEffectOnce {
  return createIngressEffectOnce({
    pluginId: "qqbot",
    namespacePrefix: `qqbot.gateway.${params.accountId}`,
    ttlMs: QQBOT_INGRESS_COMPLETED_TTL_MS,
    stateMaxEntries: QQBOT_INGRESS_COMPLETED_MAX_ENTRIES,
    onDiskError: (error) => {
      params.log?.error(`QQBot ingress effect state failed: ${formatErrorMessage(error)}`);
    },
  });
}
