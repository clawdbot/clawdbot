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
      "⚠️ The selected model was not found. Try a different model.