// GitHub Copilot source-token validation and account endpoint resolution.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { PUBLIC_GITHUB_COPILOT_DOMAIN, resolveGithubCopilotDomain } from "./domain.js";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const COPILOT_RUNTIME_AUTH_TIMEOUT_MS = 30_000;

function copilotUserUrl(domain: string): string {
  return `https://api.${domain}/copilot_internal/user`;
}

function copilotApiBaseFallback(domain: string): string {
  return domain === PUBLIC_GITHUB_COPILOT_DOMAIN
    ? DEFAULT_COPILOT_API_BASE_URL
    : `https://copilot-api.${domain}`;
}

function isTrustedCopilotApiHost(host: string, domain: string): boolean {
  if (host === "copilot-proxy.githubusercontent.com" || host.endsWith(".githubcopilot.com")) {
    return true;
  }
  return (
    domain !== PUBLIC_GITHUB_COPILOT_DOMAIN && (host === domain || host.endsWith(`.${domain}`))
  );
}

function parseCopilotApiBaseUrl(value: unknown, domain: string): string {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot user endpoint");
  }
  const endpoints = (value as { endpoints?: unknown }).endpoints;
  const api =
    endpoints && typeof endpoints === "object" ? (endpoints as { api?: unknown }).api : undefined;
  if (api === undefined || api === null || api === "") {
    return copilotApiBaseFallback(domain);
  }
  if (typeof api !== "string" || !api.trim()) {
    throw new Error("GitHub Copilot user response has an invalid endpoints.api URL");
  }
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new Error("GitHub Copilot user response has an invalid endpoints.api URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isTrustedCopilotApiHost(host, domain)
  ) {
    throw new Error("GitHub Copilot user response has an untrusted endpoints.api URL");
  }
  return url.href.replace(/\/+$/, "");
}

export async function resolveCopilotRuntimeAuth(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  githubDomain?: string;
  config?: OpenClawConfig;
}): Promise<{
  apiKey: string;
  source: string;
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const domain = resolveGithubCopilotDomain({
    env,
    explicit: params.githubDomain,
    config: params.config,
  });
  const userUrl = copilotUserUrl(domain);
  const fetchImpl = params.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(COPILOT_RUNTIME_AUTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(userUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.githubToken}`,
      },
      signal,
    });
    if (!response.ok) {
      // A capture tee must not delay the already-known authentication failure.
      if (!response.bodyUsed) {
        void response.body?.cancel().catch(() => undefined);
      }
      throw new CopilotRuntimeAuthError({ reason: "http_error", status: response.status });
    }
    const baseUrl = parseCopilotApiBaseUrl(
      await readProviderJsonResponse(response, "github-copilot.user"),
      domain,
    );
    // The current Copilot CLI/SDK resolves account metadata through `/user`,
    // then sends this original GitHub token to CAPI. The retired `/v2/token`
    // exchange rejects supported fine-grained PATs before inference.
    return {
      apiKey: params.githubToken,
      source: `validated:${userUrl}`,
      baseUrl,
    };
  } catch (error) {
    if (signal.aborted) {
      throw new CopilotRuntimeAuthError({
        reason: "timeout",
        timeoutMs: COPILOT_RUNTIME_AUTH_TIMEOUT_MS,
        cause: error,
      });
    }
    throw error;
  }
}
