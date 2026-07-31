// GitHub Copilot host allowlist. Kept as a dependency-free leaf so both the
// provider-auth SDK facade and the core GitHub Copilot OAuth runtime can share
// one canonical fail-closed check without importing each other.

export const DEFAULT_GITHUB_COPILOT_DOMAIN = "github.com";

// Matches a data-residency GHE tenant root (`<tenant>.ghe.com`, single label).
// GitHub defines a GHE.com enterprise as a dedicated `SUBDOMAIN.ghe.com` domain;
// nested hosts (`api.<tenant>.ghe.com`, `copilot-api.<tenant>.ghe.com`) are
// derived service endpoints, not tenants — accepting one would template broken
// hosts like `api.api.<tenant>.ghe.com` for the token exchange. Bare `ghe.com`
// is likewise excluded: it is not a tenant and hosts no Copilot endpoint.
const GHE_DATA_RESIDENCY_HOST = /^[a-z0-9-]+\.ghe\.com$/;

/**
 * Whether a host may be templated into a Copilot endpoint: the public host or a
 * data-residency GHE tenant (`*.ghe.com`). An absent value counts as supported
 * because callers fall back to the public default. Anything else (a scheme,
 * path, credentials, or an off-allowlist host) is not, so a persisted or
 * injected origin can be rejected before any token is sent to it.
 */
export function isSupportedGithubCopilotDomain(raw: string | undefined | null): boolean {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  // Reject scheme/path/credentials so template URL construction cannot be hijacked.
  if (!/^[a-z0-9.-]+$/.test(trimmed)) {
    return false;
  }
  return trimmed === DEFAULT_GITHUB_COPILOT_DOMAIN || GHE_DATA_RESIDENCY_HOST.test(trimmed);
}

/**
 * Coerce a user/config-supplied GitHub host to a safe bare lowercase hostname.
 *
 * Fails closed to public `github.com`: only the public host and data-residency
 * GHE tenants (`*.ghe.com`) are trusted. Any other value falls back to the
 * default rather than being used verbatim, because the resolved host becomes the
 * `api.<host>` endpoint that receives the GitHub OAuth token during exchange — a
 * typo or injected value like `evil.com` must never redirect that token.
 * (Classic self-hosted GHE Server uses arbitrary hostnames but does not host
 * Copilot, so it is deliberately out of scope.) Config-supplied hosts coerce
 * rather than throw; persisted credential origins are rejected upstream with
 * `isSupportedGithubCopilotDomain` before reaching a token request.
 */
export function normalizeGithubCopilotDomain(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (trimmed && isSupportedGithubCopilotDomain(trimmed)) {
    return trimmed;
  }
  return DEFAULT_GITHUB_COPILOT_DOMAIN;
}
