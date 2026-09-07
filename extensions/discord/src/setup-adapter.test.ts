// Discord tests cover setup adapter token-shape validation (#140497 narrow slice).
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it } from "vitest";
import { discordSetupContract } from "./setup-adapter.js";

const validate = (input: Record<string, unknown>) =>
  discordSetupContract.validateInput?.({
    cfg: {},
    accountId: DEFAULT_ACCOUNT_ID,
    input,
  } as never) ?? null;

describe("discord setup adapter token shape", () => {
  it("rejects a numeric application ID used as the bot token", () => {
    const error = validate({ token: "1234567890123456789" });
    expect(error).toMatch(/application ID/i);
  });

  it("accepts a dot-separated bot token shape", () => {
    expect(validate({ token: "MTk4NjIyNDQ3NDUy.Xyz.Abc-def_123" })).toBeNull();
  });

  it("leaves non-string credential references to the contract type check", () => {
    expect(validate({ token: { source: "exec", provider: "vault", id: "discord/work" } })).toBe(
      "token must be a string.",
    );
  });

  it("preserves the env-backed setup flow", () => {
    expect(validate({ useEnv: true })).toBeNull();
  });

  it("keeps the missing-credential error for empty input", () => {
    expect(validate({})).toBe("Discord requires token (or --use-env).");
  });
});
