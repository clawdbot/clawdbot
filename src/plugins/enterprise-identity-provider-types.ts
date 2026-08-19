/**
 * Static authority material that identifies an enterprise identity provider
 * boundary. Core validates this material before it constructs any principal.
 */
export type EnterpriseIdentityTenantBinding =
  | Readonly<{ kind: "claim"; claim: string; value: string }>
  /** The exact verified issuer is the tenant boundary for providers without a tenant claim. */
  | Readonly<{ kind: "issuer"; tenantId: string }>;

export type EnterpriseIdentityAssurancePolicy = Readonly<{
  /** ID tokens must prove a recent interactive authentication, not merely recent issuance. */
  maxAuthenticationAgeMs: number;
  /** When set, the provider must issue one of these exact assurance-class values. */
  acceptedAcrValues?: readonly string[];
  /** Every listed authentication-method reference must be present in the token. */
  requiredAmrValues?: readonly string[];
}>;

export type EnterpriseIdentityMembershipClaim = Readonly<{
  kind: "oidc-claim";
  claim: string;
  /** Missing claims are never silently converted to an empty complete snapshot. */
  required: boolean;
  /** Only these configured immutable role groups become durable memory evidence. */
  roleGroupIds: readonly string[];
  maxGroups: number;
  /** Provider-specific signals that mean the token omitted a complete group snapshot. */
  incompleteIndicators?: readonly (
    | Readonly<{ kind: "truthy-claim"; claim: string }>
    | Readonly<{ kind: "nested-key"; claim: string; key: string }>
  )[];
}>;

/**
 * Google Workspace ID tokens prove the person, but not group membership. The
 * adapter may obtain an ephemeral read-only token; core owns the pinned Cloud
 * Identity request, response validation, and resulting group snapshot.
 */
export type EnterpriseIdentityGoogleWorkspaceDirectoryMembership = Readonly<{
  kind: "google-workspace-directory";
  verifiedEmailClaim: string;
  roleGroupResourceNames: readonly string[];
  customerId?: string;
  maxGroups: number;
}>;

export type EnterpriseIdentityMembershipSource =
  | EnterpriseIdentityMembershipClaim
  | EnterpriseIdentityGoogleWorkspaceDirectoryMembership;

export type EnterpriseIdentityDirectoryAccessTokenResult =
  | Readonly<{ kind: "available"; accessToken: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type EnterpriseIdentityRequiredClaim = Readonly<{
  claim: string;
  value: string | boolean;
}>;

export type EnterpriseIdentityAuthorizationCodeFlow = Readonly<{
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  scopes: readonly string[];
}>;

export type EnterpriseIdentityProviderAuthority = {
  issuer: string;
  /** Additional exact issuer spellings accepted for this same published authority. */
  acceptedIssuerAliases?: readonly string[];
  tenantId: string;
  /** Exact OIDC audiences accepted for this tenant and issuer. */
  audiences: readonly string[];
  /** HTTPS JWKS endpoint owned by the declared issuer. */
  jwksUri: string;
  /** Enterprise providers in this first rollout all publish RSA-SHA256 ID tokens. */
  algorithm: "RS256";
  /** Exact configured tenant binding; a provider never supplies this policy. */
  tenantBinding: EnterpriseIdentityTenantBinding;
  /** OIDC authentication assurance that core enforces after signature verification. */
  assurance: EnterpriseIdentityAssurancePolicy;
  /** Public-client OIDC code+PKCE endpoints. Core owns state, nonce, and exchange. */
  authorizationCodeFlow: EnterpriseIdentityAuthorizationCodeFlow;
  /** Provider-specific claims that must match exactly, such as Google hd/email_verified. */
  requiredClaims?: readonly EnterpriseIdentityRequiredClaim[];
  /** Complete bounded role evidence carried by this signed token. */
  membership: EnterpriseIdentityMembershipSource;
  /** Maximum accepted age from token issue to protected-memory authorization. */
  maxSnapshotAgeMs: number;
};

export type EnterpriseIdentityProviderServiceAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * A plugin-owned source of enterprise identity verification material.
 *
 * This deliberately has no principal construction or membership assertion
 * method. An adapter may report that its own service is unavailable, but the
 * core identity boundary remains the only place that can construct principals.
 */
export type EnterpriseIdentityProviderAdapter = {
  providerPrefix: string;
  authorities: readonly EnterpriseIdentityProviderAuthority[];
  checkServiceAvailability?: () =>
    | EnterpriseIdentityProviderServiceAvailability
    | Promise<EnterpriseIdentityProviderServiceAvailability>;
  /** Resolves the confidential web client's secret only when core redeems a code. */
  resolveAuthorizationCodeClientSecret?: () => Promise<string | undefined>;
  /** Only relevant to google-workspace-directory membership. It never returns groups or identity facts. */
  acquireDirectoryAccessToken?: () =>
    | EnterpriseIdentityDirectoryAccessTokenResult
    | Promise<EnterpriseIdentityDirectoryAccessTokenResult>;
};
