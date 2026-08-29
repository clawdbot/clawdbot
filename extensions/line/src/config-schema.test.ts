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

  it("accepts textChunkLimit on the channel and per account", () => {
    const result = LineConfigSchema.safeParse({
      textChunkLimit: 900,
      accounts: { work: { textChunkLimit: 300 } },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.textChunkLimit).toBe(900);
      expect(result.data.accounts?.work?.textChunkLimit).toBe(300);
    }
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
});
