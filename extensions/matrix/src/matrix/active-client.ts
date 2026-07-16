import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { MatrixClient } from "./sdk.js";

const activeClients = new Map<string, MatrixClient>();

function resolveAccountKey(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  return normalized || DEFAULT_ACCOUNT_ID;
}

export function setActiveMatrixClient(
  client: MatrixClient | null,
  accountId?: string | null,
): void {
  const key = resolveAccountKey(accountId);
  if (!client) {
    activeClients.delete(key);
    return;
  }
  activeClients.set(key, client);
}

export function getActiveMatrixClient(accountId?: string | null): MatrixClient | null {
  const key = resolveAccountKey(accountId);
  return activeClients.get(key) ?? null;
}
