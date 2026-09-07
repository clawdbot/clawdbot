/**
 * OAuth identity comparison and mirroring decisions.
 * Guards cross-agent credential copy/adoption so refreshed credentials cannot
 * overwrite a different account's local auth state.
 */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  loadBundledPluginPublicSurfaceModuleSyncCore,
  MissingPublicSurfaceError,
} from "../../plugin-sdk/facade-loader.js";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";

type GithubCopilotOAuthSurface = {
  normalizeGithubCopilotOAuthScope: (raw: string | undefined) => string | undefined;
};

/** Returns whether OAuth credentials target the same provider-owned tenant. */
export function isSafeToCopyOAuthRoutingScope(
  existing: Pick<OAuthCredential, "provider" | "enterpriseUrl">,
  incoming: Pick<OAuthCredential, "provider" | "enterpriseUrl">,
): boolean {
  if (existing.provider !== incoming.provider) {
    return false;
  }
  if (existing.provider !== "github-copilot") {
    return true;
  }
  // Credential identity uses shipped policy even when plugin runtime is disabled.
  // Never select a replacement policy from an environment-controlled plugin root.
  let surface: GithubCopilotOAuthSurface;
  try {
    surface = loadBundledPluginPublicSurfaceModuleSyncCore<GithubCopilotOAuthSurface>({
      dirName: "github-copilot",
      artifactBasename: "api.js",
      env: {},
    });
  } catch (error) {
    if (error instanceof MissingPublicSurfaceError) {
      return false;
    }
    throw error;
  }
  const { normalizeGithubCopilotOAuthScope } = surface;
  const existingScope = normalizeGithubCopilotOAuthScope(existing.enterpriseUrl);
  const incomingScope = normalizeGithubCopilotOAuthScope(incoming.enterpriseUrl);
  return existingScope !== undefined && existingScope === incomingScope;
}

/** Normalize account-id style identity tokens for exact comparison. */
export function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Normalize email identity tokens for case-insensitive comparison. */
export function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

/**
 * One-sided copy gate for both directions:
 * - mirror: sub-agent refresh -> main-agent store
 * - adopt: main-agent store -> sub-agent store
 */
export function isSafeToCopyOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email"> &
    Partial<Pick<OAuthCredential, "provider" | "enterpriseUrl">>,
  incoming: Pick<OAuthCredential, "accountId" | "email"> &
    Partial<Pick<OAuthCredential, "provider" | "enterpriseUrl">>,
): boolean {
  if (
    existing.provider !== undefined &&
    incoming.provider !== undefined &&
    !isSafeToCopyOAuthRoutingScope(
      { provider: existing.provider, enterpriseUrl: existing.enterpriseUrl },
      { provider: incoming.provider, enterpriseUrl: incoming.enterpriseUrl },
    )
  ) {
    return false;
  }
  const aAcct = normalizeAuthIdentityToken(existing.accountId);
  const bAcct = normalizeAuthIdentityToken(incoming.accountId);
  const aEmail = normalizeAuthEmailToken(existing.email);
  const bEmail = normalizeAuthEmailToken(incoming.email);

  if (aAcct !== undefined && bAcct !== undefined) {
    return aAcct === bAcct;
  }
  if (aEmail !== undefined && bEmail !== undefined) {
    return aEmail === bEmail;
  }

  const aHasIdentity = aAcct !== undefined || aEmail !== undefined;
  if (aHasIdentity) {
    return false;
  }

  return true;
}

type OAuthMirrorDecisionReason =
  | "no-existing-credential"
  | "incoming-fresher"
  | "non-oauth-existing-credential"
  | "provider-mismatch"
  | "identity-mismatch-or-regression"
  | "incoming-not-fresher";

type OAuthMirrorDecision =
  | {
      shouldMirror: true;
      reason: Extract<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
    }
  | {
      shouldMirror: false;
      reason: Exclude<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
    };

/** Decide whether a refreshed OAuth credential should mirror into another store. */
export function shouldMirrorRefreshedOAuthCredential(params: {
  existing: AuthProfileCredential | undefined;
  refreshed: OAuthCredential;
}): OAuthMirrorDecision {
  const { existing, refreshed } = params;
  if (!existing) {
    return { shouldMirror: true, reason: "no-existing-credential" };
  }
  if (existing.type !== "oauth") {
    return { shouldMirror: false, reason: "non-oauth-existing-credential" };
  }
  if (existing.provider !== refreshed.provider) {
    return { shouldMirror: false, reason: "provider-mismatch" };
  }
  if (!isSafeToCopyOAuthIdentity(existing, refreshed)) {
    return { shouldMirror: false, reason: "identity-mismatch-or-regression" };
  }
  const refreshedExpires = asDateTimestampMs(refreshed.expires);
  if (refreshedExpires === undefined) {
    return { shouldMirror: false, reason: "incoming-not-fresher" };
  }
  const existingExpires = asDateTimestampMs(existing.expires);
  if (existingExpires !== undefined && existingExpires >= refreshedExpires) {
    return { shouldMirror: false, reason: "incoming-not-fresher" };
  }
  return { shouldMirror: true, reason: "incoming-fresher" };
}
