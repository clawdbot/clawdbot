export type AuthProfileConfig = {
  provider: string;
  /**
   * Auth route selected by this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   * - aws-sdk: AWS SDK default credential chain (no secret in auth-profiles.json)
   */
  mode: "api_key" | "aws-sdk" | "oauth" | "token";
  email?: string;
  displayName?: string;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Base backoff for high-confidence permanent-auth failures (minutes).
     * Default: 10.
     */
    authPermanentBackoffMinutes?: number;
    /**
     * Cap for high-confidence permanent-auth backoff (minutes). Default: 60.
     */
    authPermanentMaxMinutes?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for overloaded
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    overloadedProfileRotations?: number;
    /**
     * Fixed delay before retrying an overloaded provider/profile rotation.
     * Default: 0.
     */
    overloadedBackoffMs?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for rate-limit
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    rateLimitedProfileRotations?: number;
  };
};
