import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDefaultWhatsAppAccountId } from "./accounts.js";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";

export type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || resolveDefaultWhatsAppAccountId(loadConfig());
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return getRegisteredWhatsAppConnectionController(id)?.getActiveListener() ?? null;
}
