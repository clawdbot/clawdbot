import {
  DEFAULT_GITHUB_COPILOT_DOMAIN,
  isSupportedGithubCopilotDomain,
  normalizeGithubCopilotDomain,
} from "./github-copilot-domain.js";

export type GithubCopilotTokenEndpointResolution = {
  hasProxyEndpoint: boolean;
  baseUrl: string | null;
};

function isSupportedGithubCopilotApiHost(host: string, enterpriseDomain?: string): boolean {
  if (host === "copilot-proxy.githubusercontent.com" || host.endsWith(".githubcopilot.com")) {
    return true;
  }
  if (
    !enterpriseDomain ||
    !isSupportedGithubCopilotDomain(enterpriseDomain) ||
    normalizeGithubCopilotDomain(enterpriseDomain) === DEFAULT_GITHUB_COPILOT_DOMAIN
  ) {
    return false;
  }
  const tenant = normalizeGithubCopilotDomain(enterpriseDomain);
  return host === tenant || host.endsWith(`.${tenant}`);
}

/**
 * Resolves the optional `proxy-ep` hint embedded in a Copilot API token.
 * The hint is untrusted credential data: only GitHub-owned Copilot hosts, or
 * service hosts below the credential's validated GHE.com tenant, may receive it.
 */
export function resolveGithubCopilotTokenEndpoint(
  token: string,
  enterpriseDomain?: string,
): GithubCopilotTokenEndpointResolution {
  const match = token.trim().match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEndpoint = match?.[1]?.trim();
  if (!proxyEndpoint) {
    return { hasProxyEndpoint: false, baseUrl: null };
  }

  const urlText = /^https?:\/\//i.test(proxyEndpoint) ? proxyEndpoint : `https://${proxyEndpoint}`;
  try {
    const url = new URL(urlText);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { hasProxyEndpoint: true, baseUrl: null };
    }
    const apiHost = url.hostname.toLowerCase().replace(/^proxy\./, "api.");
    return {
      hasProxyEndpoint: true,
      baseUrl: isSupportedGithubCopilotApiHost(apiHost, enterpriseDomain)
        ? `https://${apiHost}`
        : null,
    };
  } catch {
    return { hasProxyEndpoint: true, baseUrl: null };
  }
}
