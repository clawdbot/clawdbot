import { shouldSkipLiveProviderDrift } from "./live-test-provider-drift.js";

export function isLiveAuthDrift(error: unknown): boolean {
  return shouldSkipLiveProviderDrift({ allowAuth: true, error })?.reason === "auth";
}

export function isLiveBillingDrift(error: unknown): boolean {
  return shouldSkipLiveProviderDrift({ allowBilling: true, error })?.reason === "billing";
}

export function isLiveRateLimitDrift(error: unknown): boolean {
  return shouldSkipLiveProviderDrift({ allowRateLimit: true, error })?.reason === "rate-limit";
}

export function isLiveProviderUnavailableDrift(error: unknown): boolean {
  return (
    shouldSkipLiveProviderDrift({ allowProviderUnavailable: true, error })?.reason ===
    "provider-unavailable"
  );
}
