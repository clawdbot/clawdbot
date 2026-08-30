/**
 * Scope used when classifying auth-profile failures for retry/fallback decisions.
 */
export type AuthProfileFailurePolicy = "shared" | "local" | "local_transient";
