import { describe, expect, it } from "vitest";
import { resolveQQBotEffectivePolicies } from "./resolve-policy.js";

describe("resolveQQBotEffectivePolicies", () => {
  describe("backwards-compatible inference", () => {
    it("defaults to open when no allowFrom is configured", () => {
      expect(resolveQQBotEffectivePolicies({})).toEqual({
        dmPolicy: "open",
        groupPolicy: "open",
      });
    });

    it("defaults to open when allowFrom only contains wildcard", () => {
      expect(resolveQQBotEffectivePolicies({ allowFrom: ["*"] })).toEqual({
        dmPolicy: "open",
        groupPolicy: "open",
      });
    });

    it("infers allowlist when allowFrom has a concrete entry", () => {
      expect(resolveQQBotEffectivePolicies({ allowFrom: ["USER1"] })).toEqual({
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
      });
    });

    it("infers group=allowlist when only groupAllowFrom is restricted", () => {
      expect(
        resolveQQBotEffectivePolicies({ allowFrom: ["*"], groupAllowFrom: ["USER1"] }),
      ).toEqual({
        dmPolicy: "open",
        groupPolicy: "allowlist",
      });
    });
  });

  describe("explicit policy precedence", () => {
    it("honours explicit dmPolicy over inference", () => {
      expect(
        resolveQQBotEffectivePolicies({ allowFrom: ["USER1"], dmPolicy: "open" }),
      ).toMatchObject({ dmPolicy: "open" });
    });

    it("honours explicit groupPolicy over inference", () => {
      expect(
        resolveQQBotEffectivePolicies({
          allowFrom: ["USER1"],
          groupPolicy: "disabled",
        }),
      ).toMatchObject({ groupPolicy: "disabled" });
    });

    it("allows dmPolicy=disabled to cut off DM entirely", () => {
      expect(resolveQQBotEffectivePolicies({ dmPolicy: "disabled" })).toMatchObject({
        dmPolicy: "disabled",
      });
    });
  });
});
