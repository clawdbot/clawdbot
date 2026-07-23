import { describe, expect, it } from "vitest";
import { resolveTelegramIngressNonRetryableFailure } from "./telegram-ingress-non-retryable.js";

describe("resolveTelegramIngressNonRetryableFailure", () => {
  it("returns null for a generic error", () => {
    expect(resolveTelegramIngressNonRetryableFailure(new Error("something went wrong"))).toBeNull();
  });

  it("returns null for a transient network error", () => {
    const err = new Error("ECONNREFUSED");
    (err as unknown as Record<string, unknown>).code = "ECONNREFUSED";
    expect(resolveTelegramIngressNonRetryableFailure(err)).toBeNull();
  });

  it("classifies bot-blocked error as non-retryable", () => {
    const err = new Error("403: Forbidden: bot was blocked by the user");
    (err as unknown as Record<string, unknown>).error_code = 403;
    const result = resolveTelegramIngressNonRetryableFailure(err);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("recipient-unreachable");
    expect(result!.message).toContain("bot was blocked by the user");
  });

  it("classifies bot-kicked error as non-retryable", () => {
    const err = new Error("403: Forbidden: bot was kicked from the group chat");
    (err as unknown as Record<string, unknown>).error_code = 403;
    const result = resolveTelegramIngressNonRetryableFailure(err);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("recipient-unreachable");
    expect(result!.message).toContain("bot was kicked");
  });

  it("classifies chat-not-found error as non-retryable", () => {
    const err = new Error("400: Bad Request: chat not found");
    (err as unknown as Record<string, unknown>).error_code = 400;
    const result = resolveTelegramIngressNonRetryableFailure(err);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("recipient-unreachable");
    expect(result!.message).toContain("chat not found");
  });

  it("classifies user-not-found error as non-retryable", () => {
    const err = new Error("400: Bad Request: user not found");
    (err as unknown as Record<string, unknown>).error_code = 400;
    const result = resolveTelegramIngressNonRetryableFailure(err);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("recipient-unreachable");
    expect(result!.message).toContain("user not found");
  });

  it("classifies bot-not-member error as non-retryable", () => {
    const err = new Error("403: Forbidden: bot is not a member of the channel chat");
    (err as unknown as Record<string, unknown>).error_code = 403;
    const result = resolveTelegramIngressNonRetryableFailure(err);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("recipient-unreachable");
    expect(result!.message).toContain("not a member");
  });

  it("detects permanent error nested in cause chain", () => {
    const cause = new Error("403: Forbidden: bot was blocked by the user");
    (cause as unknown as Record<string, unknown>).error_code = 403;
    const err = new Error("dispatch failed", { cause });
    const result = resolveTelegramIngressNonRetryableFailure(err);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("recipient-unreachable");
  });

  it("detects permanent error nested in error property (GrammyError shape)", () => {
    const inner = new Error("Forbidden: bot was blocked by the user");
    (inner as unknown as Record<string, unknown>).error_code = 403;
    const err = Object.assign(new Error("HttpError"), { error: inner });
    const result = resolveTelegramIngressNonRetryableFailure(err);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("recipient-unreachable");
  });
});
