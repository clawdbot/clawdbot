import { listEnabledClickClackAccounts } from "../accounts.js";
import type { CoreConfig, ResolvedClickClackAccount } from "../types.js";
import type { ClickClackDiscussionBinding } from "./binding-store.js";
import { discussionCredentialFingerprint } from "./naming.js";

export function discussionAccounts(cfg: CoreConfig): ResolvedClickClackAccount[] {
  return listEnabledClickClackAccounts(cfg).filter(
    (account) => account.configured && account.discussions.enabled,
  );
}

export function normalizedServerBaseUrl(account: ResolvedClickClackAccount): string {
  return account.baseUrl.replace(/\/+$/u, "");
}

export type DiscussionBindingAccountResolution =
  | { state: "active"; account: ResolvedClickClackAccount }
  | { state: "unavailable" }
  | { state: "stale"; account: ResolvedClickClackAccount };

/** Resolves the sole live account and rejects bindings pinned to an older destination. */
export function resolveDiscussionBindingAccount(
  cfg: CoreConfig,
  binding: ClickClackDiscussionBinding,
): DiscussionBindingAccountResolution {
  const accounts = discussionAccounts(cfg);
  if (accounts.length !== 1) {
    return { state: "unavailable" };
  }
  const account = accounts[0];
  if (!account) {
    return { state: "unavailable" };
  }
  if (
    account.accountId !== binding.accountId ||
    normalizedServerBaseUrl(account) !== binding.serverBaseUrl ||
    account.discussions.workspace !== binding.workspaceRef ||
    (binding.credentialFingerprint !== undefined &&
      discussionCredentialFingerprint(account.token) !== binding.credentialFingerprint)
  ) {
    return { state: "stale", account };
  }
  return { state: "active", account };
}
