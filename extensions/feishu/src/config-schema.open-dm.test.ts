// Feishu tests cover effective named-account DM access validation.
import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";

function expectAccountAllowFromIssue(config: Record<string, unknown>) {
  const result = FeishuConfigSchema.safeParse(config);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
      "accounts.work.allowFrom",
    );
  }
}

describe("FeishuConfigSchema named-account open DM policy", () => {
  it("rejects an explicit open account without an effective wildcard", () => {
    expectAccountAllowFromIssue({ accounts: { work: { dmPolicy: "open" } } });
  });

  it("accepts an open account that inherits the top-level wildcard", () => {
    expect(
      FeishuConfigSchema.safeParse({
        allowFrom: ["*"],
        accounts: { work: { dmPolicy: "open" } },
      }).success,
    ).toBe(true);
  });

  it("rejects an inherited open policy narrowed by an account allowlist", () => {
    expectAccountAllowFromIssue({
      dmPolicy: "open",
      allowFrom: ["*"],
      accounts: { work: { allowFrom: ["ou_alice"] } },
    });
  });

  it("accepts an account-level wildcard for an effective open policy", () => {
    expect(
      FeishuConfigSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["*"],
        accounts: { work: { allowFrom: ["*"] } },
      }).success,
    ).toBe(true);
  });

  it.each(["feishu:*", "lark:*"])(
    "accepts provider-prefixed wildcard %s for an open account",
    (wildcard) => {
      expect(
        FeishuConfigSchema.safeParse({
          accounts: { work: { dmPolicy: "open", allowFrom: [wildcard] } },
        }).success,
      ).toBe(true);
    },
  );

  it.each(["feishu:*", "lark:*"])(
    "accepts inherited provider-prefixed wildcard %s for an open account",
    (wildcard) => {
      expect(
        FeishuConfigSchema.safeParse({
          allowFrom: [wildcard],
          accounts: { work: { dmPolicy: "open" } },
        }).success,
      ).toBe(true);
    },
  );

  it("does not enforce open DM access on disabled accounts", () => {
    expect(
      FeishuConfigSchema.safeParse({
        accounts: { work: { enabled: false, dmPolicy: "open" } },
      }).success,
    ).toBe(true);
  });

  it("does not enforce account open DM access when the channel is disabled", () => {
    expect(
      FeishuConfigSchema.safeParse({
        enabled: false,
        accounts: { work: { dmPolicy: "open" } },
      }).success,
    ).toBe(true);
  });
});
