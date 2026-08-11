// Covers rate-limit message classification, including localized provider text.
import { describe, expect, it } from "vitest";
import { classifyRateLimitWindow } from "./rate-limit-window.js";

describe("classifyRateLimitWindow", () => {
  it("classifies localized Chinese usage-cap messages as short-window", () => {
    // Real-world provider message (Zhipu GLM): localized 429 text that recovers
    // within seconds, previously classified as "unknown" and skipped same-model retry.
    expect(
      classifyRateLimitWindow("您已达到每周使用上限，您的限额将在 2026-07-21 09:22:46 重置"),
    ).toEqual({ kind: "short" });
    expect(classifyRateLimitWindow("您已达到每月使用上限，您的限额将在 2026-08-01 00:00:00 重置")).toEqual({
      kind: "short",
    });
    expect(classifyRateLimitWindow("您已达到使用上限")).toEqual({ kind: "short" });
  });

  it("classifies Chinese quota-reset messages as short-window", () => {
    expect(classifyRateLimitWindow("超出限额，将在60秒后重置")).toEqual({ kind: "short" });
  });

  it("keeps existing Chinese rate-limit phrases classified as short-window", () => {
    expect(classifyRateLimitWindow("请求过于频繁，请稍后再试")).toEqual({ kind: "short" });
    expect(classifyRateLimitWindow("调用频率超出限制")).toEqual({ kind: "short" });
    expect(classifyRateLimitWindow("触发频率限制")).toEqual({ kind: "short" });
  });

  it("classifies English short-window rate limits as short", () => {
    expect(classifyRateLimitWindow("Too many requests: requests per minute exceeded")).toEqual({
      kind: "short",
    });
    expect(classifyRateLimitWindow("429 Too Many Requests")).toEqual({ kind: "short" });
  });

  it("honors retry-after values when present", () => {
    expect(classifyRateLimitWindow("Rate limit exceeded. Retry-After: 5")).toEqual({
      kind: "short",
      retryAfterSeconds: 5,
    });
    expect(classifyRateLimitWindow("Rate limit exceeded. Retry-After: 120")).toEqual({
      kind: "long",
    });
  });

  it("classifies long-window rate limits as long", () => {
    expect(classifyRateLimitWindow("You have exceeded your daily usage limit")).toEqual({
      kind: "long",
    });
    expect(classifyRateLimitWindow("insufficient_quota")).toEqual({ kind: "long" });
  });

  it("returns unknown for non-rate-limit errors", () => {
    expect(classifyRateLimitWindow("Internal server error")).toEqual({ kind: "unknown" });
    expect(classifyRateLimitWindow(undefined)).toEqual({ kind: "unknown" });
  });
});
