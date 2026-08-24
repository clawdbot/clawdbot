// GitHub Copilot data-residency domain resolution.
//
// The allowlist and env/config precedence are provider policy. Deprecated SDK
// facades keep their dated compatibility copy until its removal window closes.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/** Public GitHub Copilot host used when no data-residency domain is configured. */
export const PUBLIC_GITHUB_COPILOT_DOMAIN = "github.com";
const GHE_DATA_RESIDENCY_HOST = /^[a-z0-9-]+\.ghe\.com$/;

export function isSupportedGithubCopilotDomain(raw: string | undefined | null): boolean {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  return (
    /^[a-z0-9.-]+$/.test(trimmed) &&
    (trimmed === PUBLIC_GITHUB_COPILOT_DOMAIN || GHE_DATA_RESIDENCY_HOST.test(trimmed))
  );
}

export function normalizeGithubCopilotDomain(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  return trimmed && isSupportedGithubCopilotDomain(trimmed)
    ? trimmed
    : PUBLIC_GITHUB_COPILOT_DOMAIN;
}

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
