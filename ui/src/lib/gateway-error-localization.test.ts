import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { resolveReviewedGatewayErrorMessage } from "./gateway-error-localization.ts";

function localizedError(
  overrides: {
    code?: string;
    reason?: unknown;
    localization?: unknown;
    message?: string;
  } = {},
) {
  return new GatewayRequestError({
    code: overrides.code ?? "INVALID_REQUEST",
    message: overrides.message ?? "unknown or expired approval id",
    details: {
      reason: overrides.reason ?? "APPROVAL_NOT_FOUND",
      localization: overrides.localization ?? { messageKey: "gateway.approval.notFound" },
    },
  });
}

describe("Gateway error localization", () => {
  it("renders the exact reviewed descriptor when the active locale owns the key", () => {
    const translate = vi.fn(() => "审批请求不存在或已过期。");
    expect(resolveReviewedGatewayErrorMessage(localizedError(), translate, () => true)).toBe(
      "审批请求不存在或已过期。",
    );
    expect(translate).toHaveBeenCalledWith("gateway.approval.notFound");
  });

  it("preserves canonical English when the reviewed key has no translation", () => {
    const translate = vi.fn(() => "untrusted translation");
    expect(resolveReviewedGatewayErrorMessage(localizedError(), translate, () => false)).toBe(
      "unknown or expired approval id",
    );
    expect(translate).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed metadata", "malformed"],
    ["oversized key", { messageKey: "gateway." + "x".repeat(10_000) }],
    ["unknown key", { messageKey: "gateway.unreviewed" }],
    ["extra member", { messageKey: "gateway.approval.notFound", extra: true }],
    ["forbidden params", { messageKey: "gateway.approval.notFound", messageParams: {} }],
  ])("returns canonical Gateway English for %s", (_name, localization) => {
    const translate = vi.fn(() => "untrusted translation");
    expect(
      resolveReviewedGatewayErrorMessage(
        localizedError({ localization, message: "canonical Gateway message" }),
        translate,
        () => true,
      ),
    ).toBe("canonical Gateway message");
    expect(translate).not.toHaveBeenCalled();
  });

  it.each([
    ["code", { code: "UNAVAILABLE" }],
    ["reason", { reason: "OTHER" }],
  ])("returns canonical Gateway English for a %s mismatch", (_name, overrides) => {
    const translate = vi.fn(() => "untrusted translation");
    expect(
      resolveReviewedGatewayErrorMessage(
        localizedError({ ...overrides, message: "canonical mismatch message" }),
        translate,
        () => true,
      ),
    ).toBe("canonical mismatch message");
    expect(translate).not.toHaveBeenCalled();
  });

  it("returns canonical Gateway English when details are absent", () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "canonical no-details message",
    });
    expect(resolveReviewedGatewayErrorMessage(error)).toBe("canonical no-details message");
  });

  it("returns null for non-Gateway failures", () => {
    expect(resolveReviewedGatewayErrorMessage(new Error("network unavailable"))).toBeNull();
  });
});
