// GitHub Copilot data-residency domain resolution.
//
// Lives inside the provider so the shared plugin SDK only needs to export the
// security-critical host allowlist (`normalizeGithubCopilotDomain`). The
// env/config precedence below is GitHub Copilot provider policy, not a
// plugin-SDK contract, so it is intentionally not part of the SDK surface.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeGithubCopilotDomain } from "openclaw/plugin-sdk/provider-auth";

/** Public GitHub Copilot host used when no data-residency domain is configured. */
export const PUBLIC_GITHUB_COPILOT_DOMAIN = "github.com";

function readConfiguredGithubCopilotDomain(config?: OpenClawConfig): string | undefined {
  const params = config?.models?.providers?.["github-copilot"]?.params;
  const value = params && typeof params === "object" ? params.githubDomain : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolve the GitHub Copilot host for this provider from (in priority order) the
 * `COPILOT_GITHUB_DOMAIN` env override, the persisted
 * `models.providers.github-copilot.params.githubDomain` config, then public
 * `github.com`. The result always passes through the SDK allowlist
 * (`normalizeGithubCopilotDomain`) so an unsafe value fails closed.
 */
export function resolveGithubCopilotDomain(params?: {
  env?: NodeJS.ProcessEnv;
  explicit?: string;
  config?: OpenClawConfig;
}): string {
  const env = params?.env ?? process.env;
  const fromEnv = env.COPILOT_GITHUB_DOMAIN?.trim();
  if (fromEnv) {
    return normalizeGithubCopilotDomain(fromEnv);
  }
  if (params?.explicit) {
    return normalizeGithubCopilotDomain(params.explicit);
  }
  return normalizeGithubCopilotDomain(readConfiguredGithubCopilotDomain(params?.config));
}
