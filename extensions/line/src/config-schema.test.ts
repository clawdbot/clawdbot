// Line tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { LineConfigSchema } from "./config-schema.js";

describe("LineConfigSchema", () => {
  it("preserves root and account join-introduction overrides without materializing defaults", () => {
    const defaults = LineConfigSchema.parse({ accounts: { work: {} } });
    const configured = LineConfigSchema.parse({
      joinIntro: false,
      accounts: { work: { joinIntro: true } },
    });

    expect(defaults).not.toHaveProperty("joinIntro");
    expect(defaults.accounts?.work).not.toHaveProperty("joinIntro");
    expect(configured).toMatchObject({
      joinIntro: false,
      accounts: { work: { joinIntro: true } },
    });
  });

  it('rejects dmPolicy="open" without wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
    });

    if (result.success) {
      throw new Error("Expected config validation to fail");
    }
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(["allowFrom"]);
    expect(result.error.issues[0]?.message).toBe(
      'channels.line.dmPolicy="open" requires channels.line.allowFrom to include "*"',
    );
  });

  it('accepts dmPolicy="open" with wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
      allowFrom: ["*"],
    });

    expect(result.success).toBe(true);
  });

  it('rejects account dmPolicy="open" without wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      accounts: {
        work: {
          channelAccessToken: "token",
          channelSecret: "secret",
          dmPolicy: "open",
        },
      },
    });

    if (result.success) {
      throw new Error("Expected account config validation to fail");
    }
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(["accounts", "work", "allowFrom"]);
    expect(result.error.issues[0]?.message).toBe(
      'channels.line.dmPolicy="open" requires channels.line.allowFrom to include "*"',
    );
  });

  it("accepts SecretRef credentials on the channel and account surfaces", () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: { source: "store", provider: "default", id: "LINE_TOKEN" },
      channelSecret: { source: "file", provider: "vault", id: "/line/secret" },
      accounts: {
        work: {
          channelAccessToken: { source: "env", provider: "default", id: "WORK_LINE_TOKEN" },
          channelSecret: "work-secret",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a SecretRef whose provider alias is not a valid alias", () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: { source: "store", provider: "Not An Alias", id: "LINE_TOKEN" },
    });

    if (result.success) {
      throw new Error("Expected credential validation to fail");
    }
    expect(result.error.issues[0]?.path).toEqual(["channelAccessToken", "provider"]);
  });
});
