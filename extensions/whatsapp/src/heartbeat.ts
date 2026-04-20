import { resolveWhatsAppAccount } from "./accounts.js";
import { readWebAuthExistsForDecision, WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { loadWhatsAppChannelRuntime } from "./shared.js";

export async function checkWhatsAppHeartbeatReady(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  deps?: {
    readWebAuthExistsForDecision?: typeof readWebAuthExistsForDecision;
    hasActiveWebListener?: (accountId?: string) => boolean;
  };
}) {
  if (params.cfg.web?.enabled === false) {
    return { ok: false as const, reason: "whatsapp-disabled" as const };
  }
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const authState = await (
    params.deps?.readWebAuthExistsForDecision ?? readWebAuthExistsForDecision
  )(account.authDir);
  if (authState.outcome === "unstable") {
    return { ok: false as const, reason: WHATSAPP_AUTH_UNSTABLE_CODE };
  }
  if (!authState.exists) {
    return { ok: false as const, reason: "whatsapp-not-linked" as const };
  }
  const listenerActive = params.deps?.hasActiveWebListener
    ? params.deps.hasActiveWebListener(account.accountId)
    : Boolean((await loadWhatsAppChannelRuntime()).getActiveWebListener(account.accountId));
  if (!listenerActive) {
    return { ok: false as const, reason: "whatsapp-not-running" as const };
  }
  return { ok: true as const, reason: "ok" as const };
}
