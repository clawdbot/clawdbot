import { resolveWhatsAppAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { loadWhatsAppChannelRuntime } from "./shared.js";

export async function checkWhatsAppHeartbeatReady(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  deps?: {
    webAuthExists?: (authDir: string) => Promise<boolean>;
    hasActiveWebListener?: (accountId?: string) => boolean;
  };
}) {
  if (params.cfg.web?.enabled === false) {
    return { ok: false as const, reason: "whatsapp-disabled" as const };
  }
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const authExists = await (
    params.deps?.webAuthExists ?? (await loadWhatsAppChannelRuntime()).webAuthExists
  )(account.authDir);
  if (!authExists) {
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
