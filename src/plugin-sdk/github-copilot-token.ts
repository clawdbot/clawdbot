// Compat surface: openclaw/plugin-sdk/github-copilot-token
// Provides stable GitHub Copilot token resolution helpers for the bundled
// github-copilot provider extension.

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

const COPILOT_TOKEN_ENDPOINT =
  "https://api.github.com/copilot_internal/v2/token";

/**
 * Derives the Copilot API base URL from a raw Copilot API token by parsing
 * the optional `proxy-ep=` segment embedded in the token string.
 *
 * Token shape: `<gh-token>[;proxy-ep=<proxy-host>;[...]]`
 *
 * The proxy host may be given with or without an `https://` prefix.  The
 * returned base URL always uses the `api.` subdomain of the proxy host.
 *
 * Falls back to `DEFAULT_COPILOT_API_BASE_URL` if no proxy-ep is present.
 */
export function deriveCopilotApiBaseUrlFromToken(token: string): string {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match) {
    return DEFAULT_COPILOT_API_BASE_URL;
  }
  let proxyHost = match[1].trim();
  // Strip leading https:// or http://
  proxyHost = proxyHost.replace(/^https?:\/\//, "");
  // Replace leading "proxy." subdomain with "api."
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}

export type ResolveCopilotApiTokenParams = {
  githubToken: string;
  cachePath: string;
  loadJsonFileImpl: (path: string) => unknown;
  saveJsonFileImpl: (path: string, data: unknown) => void;
  fetchImpl?: typeof fetch;
};

export type CopilotApiTokenResult = {
  token: string;
  baseUrl: string;
  source: string;
};

type CachedTokenEntry = {
  token: string;
  expiresAt: number;
  updatedAt: number;
};

/**
 * Resolves a Copilot API token, using a JSON cache keyed by `cachePath`.
 *
 * Returns `{ token, baseUrl, source }`.  `source` is either `"cache:<path>"`
 * or `"fetch"`.
 */
export async function resolveCopilotApiToken(
  params: ResolveCopilotApiTokenParams,
): Promise<CopilotApiTokenResult> {
  const { githubToken, cachePath, loadJsonFileImpl, saveJsonFileImpl, fetchImpl = fetch } = params;
  const now = Date.now();

  const cached = loadJsonFileImpl(cachePath) as CachedTokenEntry | undefined;
  if (cached && typeof cached.token === "string" && cached.expiresAt > now) {
    return {
      token: cached.token,
      baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token),
      source: `cache:${cachePath}`,
    };
  }

  const response = await fetchImpl(COPILOT_TOKEN_ENDPOINT, {
    headers: {
      Authorization: `token ${githubToken}`,
      "Editor-Version": "openclaw/0.0.0",
      "Editor-Plugin-Version": "openclaw-copilot/0.0.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Copilot token fetch failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { token: string; expires_at: number };
  const token = body.token;
  const expiresAt = body.expires_at * 1000;

  saveJsonFileImpl(cachePath, { token, expiresAt, updatedAt: now } satisfies CachedTokenEntry);

  return {
    token,
    baseUrl: deriveCopilotApiBaseUrlFromToken(token),
    source: "fetch",
  };
}
