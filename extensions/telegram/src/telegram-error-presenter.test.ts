import { describe, expect, it } from "vitest";
import { formatTelegramFallbackError } from "./telegram-error-presenter.js";

describe("formatTelegramFallbackError", () => {
  it("maps 429 to rate limit message", () => {
    expect(formatTelegramFallbackError(new Error("Request failed with 429"))).toBe(
      "⚠️ Rate limit reached. Please wait a moment and try again.",
    );
  });

  it("maps 'rate limit exceeded' to rate limit message", () => {
    expect(formatTelegramFallbackError(new Error("rate limit exceeded"))).toBe(
      "⚠️ Rate limit reached. Please wait a moment and try again.",
    );
  });

  it("maps 408 to timeout message", () => {
    expect(formatTelegramFallbackError(new Error("Request failed with 408"))).toBe(
      "⚠️ Request timed out. Please try again.",
    );
  });

  it("maps ETIMEDOUT to timeout message", () => {
    expect(formatTelegramFallbackError(new Error("ETIMEDOUT"))).toBe(
      "⚠️ Request timed out. Please try again.",
    );
  });

  it("maps 500 to server error message", () => {
    expect(formatTelegramFallbackError(new Error("500 Internal server error"))).toBe(
      "⚠️ Provider server error. Please try again in a moment.",
    );
  });

  it("maps 502 Bad Gateway to server error message", () => {
    expect(formatTelegramFallbackError(new Error("502 Bad Gateway"))).toBe(
      "⚠️ Provider server error. Please try again in a moment.",
    );
  });

  it("maps 'Internal server error' to server error message", () => {
    expect(formatTelegramFallbackError(new Error("Internal server error"))).toBe(
      "⚠️ Provider server error. Please try again in a moment.",
    );
  });

  it("maps 529 to overloaded message", () => {
    expect(formatTelegramFallbackError(new Error("529 Overloaded"))).toBe(
      "⚠️ Provider is overloaded. Please try again in a moment.",
    );
  });

  it("maps 401 to auth message", () => {
    expect(formatTelegramFallbackError(new Error("401 Unauthorized"))).toBe(
      "⚠️ Authentication failed. Check your provider configuration.",
    );
  });

  it("maps 'unauthorized' to auth message", () => {
    expect(formatTelegramFallbackError(new Error("unauthorized access"))).toBe(
      "⚠️ Authentication failed. Check your provider configuration.",
    );
  });

  it("maps 402 to billing message", () => {
    expect(formatTelegramFallbackError(new Error("402 Payment required"))).toBe(
      "⚠️ Billing issue: insufficient credits or quota. Check your provider account.",
    );
  });

  it("maps 'insufficient credits' to billing message", () => {
    expect(formatTelegramFallbackError(new Error("insufficient credits"))).toBe(
      "⚠️ Billing issue: insufficient credits or quota. Check your provider account.",
    );
  });

  it("maps 'model not found' to model not found message", () => {
    expect(formatTelegramFallbackError(new Error("model not found: gpt-xyz"))).toBe(
      "⚠️ The selected model was not found. Try a different model.",
    );
  });

  it("maps 'no such model' to model not found message", () => {
    expect(formatTelegramFallbackError(new Error("no such model: claude-xyz"))).toBe(
      "⚠️ The selected model was not found. Try a different model.",
    );
  });

  it("returns generic message for bare 404 without model-specific text", () => {
    expect(formatTelegramFallbackError(new Error("404 Not Found"))).toBe(
      "Something went wrong while processing your request. Please try again.",
    );
  });

  it("returns generic message for non-model 404 (missing endpoint)", () => {
    expect(
      formatTelegramFallbackError(new Error("404: /v1/deployments/xyz/completions not found")),
    ).toBe("Something went wrong while processing your request. Please try again.");
  });

  it("maps context overflow to context overflow message", () => {
    expect(formatTelegramFallbackError(new Error("context window exceeded"))).toBe(
      "⚠️ Context overflow: prompt too large for the model. Use /new to start a fresh session.",
    );
  });

  it("maps 'prompt is too long' to context overflow message", () => {
    expect(formatTelegramFallbackError(new Error("prompt is too long"))).toBe(
      "⚠️ Context overflow: prompt too large for the model. Use /new to start a fresh session.",
    );
  });

  it("returns generic message for unknown errors", () => {
    expect(formatTelegramFallbackError(new Error("something unusual happened"))).toBe(
      "Something went wrong while processing your request. Please try again.",
    );
  });

  it("returns generic message for empty error text", () => {
    expect(formatTelegramFallbackError(new Error(""))).toBe(
      "Something went wrong while processing your request. Please try again.",
    );
  });

  it("returns generic message for non-Error values", () => {
    expect(formatTelegramFallbackError(undefined)).toBe(
      "Something went wrong while processing your request. Please try again.",
    );
    expect(formatTelegramFallbackError(null)).toBe(
      "Something went wrong while processing your request. Please try again.",
    );
    expect(formatTelegramFallbackError({})).toBe(
      "Something went wrong while processing your request. Please try again.",
    );
  });

  it("does not leak endpoint URLs in output", () => {
    const err = new Error(
      "Request to https://api.provider.com/v1/chat failed with 500 Internal server error",
    );
    const result = formatTelegramFallbackError(err);
    expect(result).not.toContain("https://");
    expect(result).not.toContain("api.provider.com");
    expect(result).toBe("⚠️ Provider server error. Please try again in a moment.");
  });

  it("does not leak file paths in output", () => {
    const err = new Error("Failed to read /etc/secrets/api-key.txt: 401 Unauthorized");
    const result = formatTelegramFallbackError(err);
    expect(result).not.toContain("/etc/secrets/");
    expect(result).not.toContain("api-key.txt");
    expect(result).toBe("⚠️ Authentication failed. Check your provider configuration.");
  });

  it("does not leak raw diagnostics for unknown errors", () => {
    const err = new Error("ECONNREFUSED 10.0.0.42:443");
    const result = formatTelegramFallbackError(err);
    expect(result).not.toContain("10.0.0.42");
    expect(result).not.toContain("ECONNREFUSED");
    expect(result).toBe("Something went wrong while processing your request. Please try again.");
  });

  it("classifies 503 Service Unavailable as server error", () => {
    expect(formatTelegramFallbackError(new Error("503 Service Unavailable"))).toBe(
      "⚠️ Provider server error. Please try again in a moment.",
    );
  });

  it("classifies 'too many requests' as rate limit", () => {
    expect(formatTelegramFallbackError(new Error("too many requests"))).toBe(
      "⚠️ Rate limit reached. Please wait a moment and try again.",
    );
  });

  it("classifies 'throttled' as rate limit", () => {
    expect(formatTelegramFallbackError(new Error("request was throttled"))).toBe(
      "⚠️ Rate limit reached. Please wait a moment and try again.",
    );
  });

  it("classifies 'gateway timeout' as timeout", () => {
    expect(formatTelegramFallbackError(new Error("gateway timeout"))).toBe(
      "⚠️ Request timed out. Please try again.",
    );
  });

  it("classifies 'forbidden' as auth error", () => {
    expect(formatTelegramFallbackError(new Error("forbidden access"))).toBe(
      "⚠️ Authentication failed. Check your provider configuration.",
    );
  });

  it("classifies 'spend limit' as billing error", () => {
    expect(formatTelegramFallbackError(new Error("spend limit reached"))).toBe(
      "⚠️ Billing issue: insufficient credits or quota. Check your provider account.",
    );
  });
});
