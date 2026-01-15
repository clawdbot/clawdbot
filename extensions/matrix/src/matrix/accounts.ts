import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../../src/routing/session-key.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { resolveMatrixConfig } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials.js";

export type ResolvedMatrixAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  config: MatrixConfig;
};

export function listMatrixAccountIds(_cfg: CoreConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  const ids = listMatrixAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const base = (params.cfg.channels?.matrix ?? {}) as MatrixConfig;
  const enabled = base.enabled !== false;
  const resolved = resolveMatrixConfig(params.cfg, process.env);
  const hasCore = Boolean(resolved.homeserver && resolved.userId);
  const hasToken = Boolean(resolved.accessToken || resolved.password);
  const stored = loadMatrixCredentials(process.env);
  const hasStored =
    stored &&
    resolved.homeserver &&
    resolved.userId &&
    credentialsMatchConfig(stored, {
      homeserver: resolved.homeserver,
      userId: resolved.userId,
    });
  const configured = hasCore && (hasToken || Boolean(hasStored));
  return {
    accountId,
    enabled,
    name: base.name?.trim() || undefined,
    configured,
    homeserver: resolved.homeserver || undefined,
    userId: resolved.userId || undefined,
    config: base,
  };
}

export function listEnabledMatrixAccounts(cfg: CoreConfig): ResolvedMatrixAccount[] {
  return listMatrixAccountIds(cfg)
    .map((accountId) => resolveMatrixAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
