import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { resolveReviewedGatewayErrorMessage } from "./gateway-error-localization.ts";

function localizedError(overrides: { code?: string; reason?: string; key?: string } = {}) {
  return new GatewayRequestError({
    code: overrides.code ?? "INVALID_REQUEST",
    message: "unknown or expired approval id",
    details: {
      reason: overrides.reason ?? "APPROVAL_NOT_FOUND",
      localization: { messageKey: overrides.key ?? "gateway.approval.notFound" },
    },
  });
}

describe("Gateway error localization", () => {
  it("renders a reviewed descriptor when the active locale owns the key", () => {
    const translate = vi.fn(() => "审批请求不存在或已过期。");
    expect(resolveReviewedGatewayErrorMessage(localizedError(), translate, () => true)).toBe(
      "审批请求不存在或已过期。",
    );
    expect(translate).toHaveBeenCalledWith("gateway.approval.notFound", undefined);
  });

  it("preserves canonical English for a reviewed descriptor without a catalog entry", () => {
    const translate = vi.fn(() => "untrusted translation");
    expect(resolveReviewedGatewayErrorMessage(localizedError(), translate, () => false)).toBe(
      "unknown or expired approval id",
    );
  });

  it("rejects unknown and mismatched descriptors", () => {
    const translate = vi.fn(() => "untrusted translation");
    expect(
      resolveReviewedGatewayErrorMessage(
        localizedError({ key: "gateway.unreviewed" }),
        translate,
        () => true,
      ),
    ).toBeNull();
    expect(
      resolveReviewedGatewayErrorMessage(
        localizedError({ reason: "OTHER" }),
        translate,
        () => true,
      ),
    ).toBeNull();
    expect(
      resolveReviewedGatewayErrorMessage(
        localizedError({ code: "UNAVAILABLE" }),
        translate,
        () => true,
      ),
    ).toBeNull();
  });

  it("returns canonical English only for a reviewed untranslated descriptor", () => {
    expect(resolveReviewedGatewayErrorMessage(localizedError(), vi.fn(), () => false)).toBe(
      "unknown or expired approval id",
    );
    expect(
      resolveReviewedGatewayErrorMessage(
        localizedError({ key: "gateway.unreviewed" }),
        vi.fn(),
        () => true,
      ),
    ).toBeNull();
  });

  it("returns null when no reviewed localized message can be rendered", () => {
    expect(resolveReviewedGatewayErrorMessage(new Error("network unavailable"))).toBeNull();
  });
});
