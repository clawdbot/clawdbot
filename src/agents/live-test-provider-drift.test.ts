import { describe, expect, it } from "vitest";
import {
  isLiveAuthDrift,
  isLiveBillingDrift,
  isLiveProviderUnavailableDrift,
  isLiveRateLimitDrift,
  shouldSkipLiveProviderDrift,
} from "./live-test-provider-drift.js";

describe("live test provider drift", () => {
  it("classifies provider account drift", () => {
    expect(
      isLiveBillingDrift(new Error("Your credit balance is too low to access the Anthropic API.")),
    ).toBe(true);
    expect(isLiveBillingDrift("billing has been disabled for this API key")).toBe(true);
    expect(isLiveBillingDrift("insufficient credit")).toBe(true);
    expect(
      isLiveAuthDrift('401 {"error":{"message":"The API key you provided is invalid."}}'),
    ).toBe(true);
  });

  it("classifies API-key rate-limit drift", () => {
    expect(isLiveRateLimitDrift("resource exhausted")).toBe(true);
  });

  it("classifies transient provider availability drift", () => {
    expect(
      isLiveProviderUnavailableDrift(
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      ),
    ).toBe(true);
    expect(
      isLiveProviderUnavailableDrift(
        "Error: <html><head><title>Service Unavailable</title></head><body>try again</body></html>",
      ),
    ).toBe(true);
    expect(
      isLiveProviderUnavailableDrift(
        "Error: <html><head><title>500 Internal Server Error</title></head><body>try again</body></html>",
      ),
    ).toBe(true);
    expect(
      isLiveProviderUnavailableDrift("provider returned error: 502 Internal Server Error"),
    ).toBe(true);
    expect(
      isLiveProviderUnavailableDrift(
        "Service temporarily unavailable. The model is at capacity and currently cannot serve this request.",
      ),
    ).toBe(true);
  });

  it("returns explicit skip labels only for enabled drift classes", () => {
    expect(
      shouldSkipLiveProviderDrift({
        error: '401 {"error":{"message":"The API key you provided is invalid."}}',
        allowAuth: true,
      }),
    ).toEqual({ reason: "auth", label: "auth drift" });
    expect(
      shouldSkipLiveProviderDrift({
        error: '401 {"error":{"message":"The API key you provided is invalid."}}',
        allowBilling: true,
      }),
    ).toBeUndefined();
  });
});
