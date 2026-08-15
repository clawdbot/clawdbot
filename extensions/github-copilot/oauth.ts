import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthDoctorHintContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  isSupportedGithubCopilotDomain,
  normalizeGithubCopilotDomain,
  PUBLIC_GITHUB_COPILOT_DOMAIN,
} from "./domain.js";
import { runGitHubCopilotDeviceFlow } from "./login.js";

const LEGACY_OAUTH_KEY_PREFIX = "openclaw-github-copilot-oauth:v1:";

function parseLegacyEnterpriseInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function requireSupportedEnterpriseDomain(raw: string): string {
  const domain = parseLegacyEnterpriseInput(raw);
  if (!domain || !isSupportedGithubCopilotDomain(domain)) {
    throw new Error(
      `Unsupported GitHub Enterprise domain "${raw.trim()}". Use github.com or a *.ghe.com data-residency tenant.`,
    );
  }
  return normalizeGithubCopilotDomain(domain);
}

export async function loginGithubCopilotOAuth(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const input = await callbacks.onPrompt({
    message: "GitHub Enterprise URL/domain (blank for github.com)",
    placeholder: "company.ghe.com",
    allowEmpty: true,
  });
  if (callbacks.signal?.aborted) {
    throw new Error("GitHub Copilot login cancelled");
  }
  const enterpriseUrl = input.trim() ? requireSupportedEnterpriseDomain(input) : undefined;
  const domain = enterpriseUrl ?? PUBLIC_GITHUB_COPILOT_DOMAIN;
  callbacks.onProgress?.("Waiting for GitHub authorization...");
  const result = await runGitHubCopilotDeviceFlow(
    {
      showCode: async ({ verificationUrl, userCode }) => {
        callbacks.onAuth({ url: verificationUrl, instructions: `Enter code: ${userCode}` });
      },
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    },
    domain,
  );
  if (result.status === "access_denied") {
    throw new Error("GitHub Copilot login cancelled");
  }
  if (result.status === "expired") {
    throw new Error("GitHub Copilot device code expired; retry login");
  }
  return {
    refresh: result.accessToken,
    access: result.accessToken,
    expires: MAX_DATE_TIMESTAMP_MS,
    ...(enterpriseUrl ? { enterpriseUrl } : {}),
  };
}

export function refreshGithubCopilotOAuth(credential: OAuthCredential) {
  if (credential.enterpriseUrl && !isSupportedGithubCopilotDomain(credential.enterpriseUrl)) {
    throw new Error(
      `Refusing to refresh GitHub Copilot OAuth for unsupported enterprise domain "${credential.enterpriseUrl}". Re-authenticate with github.com or a *.ghe.com tenant.`,
    );
  }
  return {
    ...credential,
    access: credential.refresh,
    expires: MAX_DATE_TIMESTAMP_MS,
  };
}

export function formatGithubCopilotApiKey(credential: {
  type: string;
  refresh?: string;
  enterpriseUrl?: string;
}): string {
  if (credential.type !== "oauth" || typeof credential.refresh !== "string") {
    return "";
  }
  const token = credential.refresh.trim();
  if (!credential.enterpriseUrl) {
    return token;
  }
  const githubDomain = requireSupportedEnterpriseDomain(credential.enterpriseUrl);
  return `${LEGACY_OAUTH_KEY_PREFIX}${JSON.stringify({ token, githubDomain })}`;
}

export function parseGithubCopilotApiKey(value: string): {
  githubToken: string;
  githubDomain?: string;
} {
  if (!value.startsWith(LEGACY_OAUTH_KEY_PREFIX)) {
    return { githubToken: value };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(LEGACY_OAUTH_KEY_PREFIX.length));
  } catch {
    throw new Error("Invalid GitHub Copilot legacy OAuth credential metadata");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid GitHub Copilot legacy OAuth credential metadata");
  }
  const { token, githubDomain } = parsed as Record<string, unknown>;
  if (
    typeof token !== "string" ||
    !token.trim() ||
    typeof githubDomain !== "string" ||
    !isSupportedGithubCopilotDomain(githubDomain)
  ) {
    throw new Error("Invalid GitHub Copilot legacy OAuth credential metadata");
  }
  return { githubToken: token, githubDomain: normalizeGithubCopilotDomain(githubDomain) };
}

export function buildGithubCopilotAuthDoctorHint(
  context: ProviderAuthDoctorHintContext,
): string | undefined {
  const profiles = context.profileId
    ? [context.store.profiles[context.profileId]]
    : Object.values(context.store.profiles);
  const unsupported = profiles.some(
    (profile) =>
      profile?.type === "oauth" &&
      profile.provider.trim().toLowerCase() === "github-copilot" &&
      !isSupportedGithubCopilotDomain(profile.enterpriseUrl),
  );
  if (!unsupported) {
    return undefined;
  }
  return "This GitHub Copilot OAuth profile has an unsupported enterprise domain and can no longer refresh. Remove the legacy profile before re-authenticating with a supported host (github.com or a *.ghe.com tenant): openclaw models auth login --provider github-copilot --force.";
}
