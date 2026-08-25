import { describe, expect, it } from "vitest";
import type { CliOutput, CliSubscriptionRateLimit } from "../cli-output-contracts.js";
import { parseClaudeCliRateLimit } from "../cli-output-records.js";
import { formatCliSubscriptionRateLimitDigest } from "./log.js";
import { createCliOutputFailoverError } from "./output-error.js";

const OBSERVED_RATE_LIMIT: CliSubscriptionRateLimit = {
  status: "allowed",
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
  isUsingOverage: false,
  windows: {
    five_hour: { utilization: 0.36, resetsAt: 1787680200 },
    seven_day: { utilization: 0.28, resetsAt: 1788138000 },
  },
};

const BASE_ERROR =
  "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.";

describe("formatCliSubscriptionRateLimitDigest", () => {
  it("formats the observed subscription windows", () => {
    expect(formatCliSubscriptionRateLimitDigest(OBSERVED_RATE_LIMIT)).toBe(
      "rateLimit=allowed five_hour=36%→2026-08-25T17:50Z seven_day=28% overage=rejected(org_level_disabled)",
    );
  });

  it("formats the minimum rate-limit record", () => {
    expect(formatCliSubscriptionRateLimitDigest({ status: "rejected", windows: {} })).toBe(
      "rateLimit=rejected",
    );
  });
});

describe("createCliOutputFailoverError", () => {
  it("appends subscription facts to billing failures while preserving rawError", () => {
    const output: CliOutput = {
      text: "",
      errorText: BASE_ERROR,
      diagnostics: { rateLimit: OBSERVED_RATE_LIMIT },
    };

    const error = createCliOutputFailoverError({
      output,
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
    });

    expect(error?.reason).toBe("billing");
    expect(error?.message).toBe(
      `${BASE_ERROR} Subscription rate limit: rateLimit=allowed five_hour=36%→2026-08-25T17:50Z seven_day=28% overage=rejected(org_level_disabled).`,
    );
    expect(error?.rawError).toBe(BASE_ERROR);
  });

  it("carries credits-required recovery facts from the stream event into the billing error", () => {
    const rateLimit = parseClaudeCliRateLimit({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parsed: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          errorCode: "credits_required",
          canUserPurchaseCredits: true,
          hasChargeableSavedPaymentMethod: false,
        },
      },
    });
    const output: CliOutput = { text: "", errorText: BASE_ERROR, diagnostics: { rateLimit } };

    const error = createCliOutputFailoverError({
      output,
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
    });

    expect(error?.reason).toBe("billing");
    expect(error?.message).toBe(
      `${BASE_ERROR} Subscription rate limit: rateLimit=rejected error=credits_required canPurchaseCredits=true savedPaymentMethod=false.`,
    );
  });

  it("does not append facts to unrelated failures", () => {
    const output: CliOutput = {
      text: "",
      errorText: "unrelated failure",
      diagnostics: { rateLimit: { status: "rejected", windows: {} } },
    };

    const error = createCliOutputFailoverError({
      output,
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
    });

    expect(error?.message).toBe("unrelated failure");
  });
});
