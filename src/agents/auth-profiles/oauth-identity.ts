import type { AuthProfileCredential, OAuthCredential } from "./types.js";

export function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

/**
 * Returns true if `existing` and `incoming` provably belong to the same
 * account. Used to gate cross-agent credential mirroring.
 */
export function isSameOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  const aAcct = normalizeAuthIdentityToken(existing.accountId);
  const bAcct = normalizeAuthIdentityToken(incoming.accountId);
  const aEmail = normalizeAuthEmailToken(existing.email);
  const bEmail = normalizeAuthEmailToken(incoming.email);
  const aHasIdentity = aAcct !== undefined || aEmail !== undefined;
  const bHasIdentity = bAcct !== undefined || bEmail !== undefined;

  if (aHasIdentity !== bHasIdentity) {
    return false;
  }

  if (aHasIdentity) {
    if (aAcct !== undefined && bAcct !== undefined) {
      return aAcct === bAcct;
    }
    if (aEmail !== undefined && bEmail !== undefined) {
      return aEmail === bEmail;
    }
    return false;
  }

  return true;
}

/**
 * One-sided copy gate for both directions:
 * - mirror: sub-agent refresh -> main-agent store
 * - adopt: main-agent store -> sub-agent store
 */
export function isSafeToCopyOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
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

export type OAuthMirrorDecisionReason =
  | "no-existing-credential"
  | "incoming-fresher"
  | "non-oauth-existing-credential"
  | "provider-mismatch"
  | "identity-mismatch-or-regression"
  | "incoming-not-fresher";

export type OAuthMirrorDecision =
  | {
      shouldMirror: true;
      reason: Extract<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
    }
  | {
      shouldMirror: false;
      reason: Exclude<OAuthMirrorDecisionReason, "no-existing-credential" | "incoming-fresher">;
    };

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
  if (
    Number.isFinite(existing.expires) &&
    Number.isFinite(refreshed.expires) &&
    existing.expires >= refreshed.expires
  ) {
    return { shouldMirror: false, reason: "incoming-not-fresher" };
  }
  return { shouldMirror: true, reason: "incoming-fresher" };
}
