const OAUTH_PROVIDER_CONFIGURED_UNAVAILABLE = "OAUTH_PROVIDER_CONFIGURED_UNAVAILABLE" as const;

/** A known OAuth provider could not load its owning plugin or required auth hooks. */
export class OAuthProviderConfiguredUnavailableError extends Error {
  readonly code = OAUTH_PROVIDER_CONFIGURED_UNAVAILABLE;
  readonly state = "configured-unavailable" as const;
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `OAuth provider "${providerId}" is configured but unavailable. Install or enable its owning plugin, then retry; run openclaw doctor for diagnostics.`,
    );
    this.name = "OAuthProviderConfiguredUnavailableError";
    this.providerId = providerId;
  }
}
