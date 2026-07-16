import { describe, expect, it } from "vitest";
import {
  resolveFeishuWebhookAnomalyDefaultsForTest,
  resolveFeishuWebhookRateLimitDefaultsForTest,
} from "./monitor.state.js";

describe("feishu monitor state defaults", () => {
  it("falls back to hard defaults when sdk defaults are missing", () => {
    expect(resolveFeishuWebhookRateLimitDefaultsForTest(undefined)).toEqual({
      windowMs: 60_000,
      maxRequests: 120,
      maxTrackedKeys: 4_096,
    });
    expect(resolveFeishuWebhookAnomalyDefaultsForTest(undefined)).toEqual({
      maxTrackedKeys: 4_096,
      ttlMs: 21_600_000,
      logEvery: 25,
    });
  });

  it("keeps valid sdk values and repairs invalid fields", () => {
    expect(
      resolveFeishuWebhookRateLimitDefaultsForTest({
        windowMs: 45_000,
        maxRequests: 0,
        maxTrackedKeys: -1,
      }),
    ).toEqual({
      windowMs: 45_000,
      maxRequests: 120,
      maxTrackedKeys: 4_096,
    });

    expect(
      resolveFeishuWebhookAnomalyDefaultsForTest({
        maxTrackedKeys: 2048,
        ttlMs: Number.NaN,
        logEvery: 10,
      }),
    ).toEqual({
      maxTrackedKeys: 2048,
      ttlMs: 21_600_000,
      logEvery: 10,
    });
  });
});
