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
        voiceChannelId: "1496962069025263624",
        driverBotToken: " driver-token ",
        sutBotToken: "sut-token",
        sutApplicationId: "1496963665587601428",
        ignored: true,
      }),
    ).toEqual({
      guildId: "1496962067029299350",
      channelId: "1496962068027281447",
      voiceChannelId: "1496962069025263624",
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

  it("rejects malformed optional Discord voice channel ids", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("discord", {
        guildId: "1496962067029299350",
        channelId: "1496962068027281447",
        voiceChannelId: "voice-channel",
        driverBotToken: "driver-token",
        sutBotToken: "sut-token",
        sutApplicationId: "1496963665587601428",
      }),
    ).toThrow(/voiceChannelId/u);
  });

  it("keeps unknown credential kinds pass-through-compatible", () => {
    const payload = { anything: true };

    expect(normalizeCredentialPayloadForKind("future-kind", payload)).toBe(payload);
  });

  it("normalizes WhatsApp credential payloads", () => {
    expect(
      normalizeCredentialPayloadForKind("whatsapp", {
        driverPhoneE164: "+15550000001",
        sutPhoneE164: "+15550000002",
        driverAuthArchiveBase64: "driver-archive",
        sutAuthArchiveBase64: "sut-archive",
        groupJid: "120363000000000000@g.us",
      }),
    ).toEqual({
      driverPhoneE164: "+15550000001",
      sutPhoneE164: "+15550000002",
      driverAuthArchiveBase64: "driver-archive",
      sutAuthArchiveBase64: "sut-archive",
      groupJid: "120363000000000000@g.us",
    });
  });

  it("rejects WhatsApp payloads with duplicate phone numbers", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("whatsapp", {
        driverPhoneE164: "+15550000001",
        sutPhoneE164: "+15550000001",
        driverAuthArchiveBase64: "driver-archive",
        sutAuthArchiveBase64: "sut-archive",
      }),
    ).toThrow("distinct driverPhoneE164 and sutPhoneE164");
  });
});
