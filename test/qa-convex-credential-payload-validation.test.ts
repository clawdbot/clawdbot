import { describe, expect, it } from "vitest";
import {
  CredentialPayloadValidationError,
  normalizeCredentialPayloadForKind,
} from "../qa/convex-credential-broker/convex/payload-validation.js";

describe("QA Convex credential payload validation", () => {
  it("normalizes Discord credential payloads", () => {
    expect(
      normalizeCredentialPayloadForKind("discord", {
        guildId: " 1496962067029299350 ",
        channelId: "1496962068027281447",
        driverBotToken: " driver-token ",
        sutBotToken: "sut-token",
        sutApplicationId: "1496963665587601428",
        ignored: true,
      }),
    ).toEqual({
      guildId: "1496962067029299350",
      channelId: "1496962068027281447",
      driverBotToken: "driver-token",
      sutBotToken: "sut-token",
      sutApplicationId: "1496963665587601428",
    });
  });

  it("rejects malformed Discord snowflakes", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("discord", {
        guildId: "not-a-snowflake",
        channelId: "1496962068027281447",
        driverBotToken: "driver-token",
        sutBotToken: "sut-token",
        sutApplicationId: "1496963665587601428",
      }),
    ).toThrow(CredentialPayloadValidationError);
  });

  it("rejects empty Discord bot tokens", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("discord", {
        guildId: "1496962067029299350",
        channelId: "1496962068027281447",
        driverBotToken: " ",
        sutBotToken: "sut-token",
        sutApplicationId: "1496963665587601428",
      }),
    ).toThrow(/driverBotToken/u);
  });

  it("keeps unknown credential kinds pass-through-compatible", () => {
    const payload = { anything: true };

    expect(normalizeCredentialPayloadForKind("future-kind", payload)).toBe(payload);
  });
});
