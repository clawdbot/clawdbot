import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  resolveGatewayErrorMessage,
  resolveReviewedGatewayErrorMessage,
  tryResolveLocalizedGatewayErrorMessage,
} from "./gateway-error-localization.ts";

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
    expect(resolveGatewayErrorMessage(localizedError(), translate, () => true)).toBe(
      "审批请求不存在或已过期。",
    );
    expect(translate).toHaveBeenCalledWith("gateway.approval.notFound", undefined);
  });

  it("preserves canonical English for missing, unknown, and mismatched descriptors", () => {
    const translate = vi.fn(() => "untrusted translation");
    expect(resolveGatewayErrorMessage(localizedError(), translate, () => false)).toBe(
      "unknown or expired approval id",
    );
    expect(
      resolveGatewayErrorMessage(
        localizedError({ key: "gateway.unreviewed" }),
        translate,
        () => true,
      ),
    ).toBe("unknown or expired approval id");
    expect(
      resolveGatewayErrorMessage(localizedError({ reason: "OTHER" }), translate, () => true),
    ).toBe("unknown or expired approval id");
    expect(
      resolveGatewayErrorMessage(localizedError({ code: "UNAVAILABLE" }), translate, () => true),
    ).toBe("unknown or expired approval id");
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
    expect(tryResolveLocalizedGatewayErrorMessage(new Error("network unavailable"))).toBeNull();
  });
});
