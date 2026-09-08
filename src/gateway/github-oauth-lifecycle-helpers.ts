import { isDeepStrictEqual } from "node:util";
import { matchesAgentLifecycleBinding } from "../agents/agent-lifecycle-registry.js";
import { listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import type {
  GitHubDeviceAuthorizationRecord,
  GitHubIdentityScope,
  GitHubOAuthRecord,
} from "../agents/github-oauth-records.js";
import type { GitHubToolAccount } from "../agents/github-tool-account.js";
import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";

export const REFRESH_SKEW_MS = 10 * 60_000;
export const MAINTENANCE_INTERVAL_MS = 60_000;
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 31_000;

export type ConfiguredOAuthIdentity = {
  scope: GitHubIdentityScope;
  agentId: string;
  identity: GitHubToolIdentityConfig & { kind: "oauth" };
};

export const defaultGitAuthor = (account: GitHubToolAccount) => ({
  name: account.login,
  email: `${account.accountId}+${account.login}@users.noreply.github.com`,
});

export function identityStillSelected(
  config: OpenClawConfig,
  location: { scope: GitHubIdentityScope; agentId: string },
  expected: GitHubToolIdentityConfig | null,
): boolean {
  const current = resolveConfiguredGitHubToolIdentity({ config, ...location });
  return isDeepStrictEqual(current ?? null, expected);
}

export function authorizationStillOwned(
  config: OpenClawConfig,
  record: GitHubDeviceAuthorizationRecord,
): boolean {
  return (
    identityStillSelected(config, record, record.expectedIdentity) &&
    (record.scope === "system" ||
      (record.agentLifecycleBinding !== undefined &&
        matchesAgentLifecycleBinding(config, record.agentLifecycleBinding)))
  );
}

export function configuredOAuthIdentities(config: OpenClawConfig): ConfiguredOAuthIdentity[] {
  const identities: ConfiguredOAuthIdentity[] = [];
  const system = config.tools?.github;
  if (system?.kind === "oauth") {
    identities.push({
      scope: "system",
      agentId: "system",
      identity: { ...system, kind: "oauth" },
    });
  }
  for (const agentId of listAgentIds(config).toSorted()) {
    const identity = resolveAgentConfig(config, agentId)?.tools?.github;
    if (identity?.kind === "oauth") {
      identities.push({ scope: "agent", agentId, identity: { ...identity, kind: "oauth" } });
    }
  }
  return identities;
}

export function currentIdentityForRecord(
  config: OpenClawConfig,
  record: Pick<GitHubOAuthRecord, "scope" | "agentId">,
): GitHubToolIdentityConfig | undefined {
  return resolveConfiguredGitHubToolIdentity({ config, ...record });
}
