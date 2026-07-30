// QA Convex credential tests validate credential payload shapes.
import { describe, expect, it } from "vitest";
import { normalizeCredentialPayloadForKind } from "../qa/convex-credential-broker/convex/payload_validation.js";

const BUZZ_DRIVER_PRIVATE_KEY = "01".repeat(32);
const BUZZ_SUT_PRIVATE_KEY = "02".repeat(32);
const BUZZ_DRIVER_NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";

describe("QA Convex credential payload validation", () => {
  it("normalizes Buzz credential payloads", () => {
    expect(
      normalizeCredentialPayloadForKind("buzz", {
        relayUrl: " wss://relay.qa.example ",
        roomId: " 123E4567-E89B-42D3-A456-426614174000 ",
        driverPrivateKey: ` ${BUZZ_DRIVER_PRIVATE_KEY} `,
        sutPrivateKey: ` ${BUZZ_SUT_PRIVATE_KEY} `,
        driverAuthTag: ' ["auth","driver","conditions","signature"] ',
        ignored: true,
      }),
    ).toEqual({
      relayUrl: "wss://relay.qa.example",
      roomId: "123e4567-e89b-42d3-a456-426614174000",
      driverPrivateKey: BUZZ_DRIVER_PRIVATE_KEY,
      sutPrivateKey: BUZZ_SUT_PRIVATE_KEY,
      driverAuthTag: '["auth","driver","conditions","signature"]',
    });
  });

  it.each(["ws://localhost:8080", "ws://127.0.0.1:8080", "ws://[::1]:8080"])(
    "allows plaintext loopback Buzz relay URL %s",
    (relayUrl) => {
      expect(
        normalizeCredentialPayloadForKind("buzz", {
          relayUrl,
          roomId: "123e4567-e89b-42d3-a456-426614174000",
          driverPrivateKey: BUZZ_DRIVER_PRIVATE_KEY,
          sutPrivateKey: BUZZ_SUT_PRIVATE_KEY,
        }),
      ).toMatchObject({ relayUrl });
    },
  );

  it("rejects plaintext remote Buzz relay URLs", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        relayUrl: "ws://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: BUZZ_DRIVER_PRIVATE_KEY,
        sutPrivateKey: BUZZ_SUT_PRIVATE_KEY,
      }),
    ).toThrow(/wss:\/\//u);
  });

  it("rejects malformed Buzz credential payloads without echoing values", () => {
    const privateKey = BUZZ_DRIVER_PRIVATE_KEY;
    const invalidRelay = "https://relay.qa.example/private-path";
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        relayUrl: invalidRelay,
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: privateKey,
        sutPrivateKey: privateKey,
      }),
    ).toThrow(/wss:\/\//u);
    try {
      normalizeCredentialPayloadForKind("buzz", {
        relayUrl: "wss://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: privateKey,
        sutPrivateKey: privateKey,
      });
    } catch (error) {
      expect(String(error)).not.toContain(privateKey);
    }
  });

  it("rejects runtime-invalid Buzz secrets and equivalent key encodings", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        relayUrl: "wss://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: BUZZ_DRIVER_PRIVATE_KEY,
        sutPrivateKey: BUZZ_DRIVER_NSEC,
      }),
    ).toThrow(/distinct driver and SUT identities/u);
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        relayUrl: "wss://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: "not-a-private-key",
        sutPrivateKey: BUZZ_SUT_PRIVATE_KEY,
      }),
    ).toThrow(/nsec or 64-character hex private key/u);
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        relayUrl: "wss://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: BUZZ_DRIVER_PRIVATE_KEY,
        sutPrivateKey: BUZZ_SUT_PRIVATE_KEY,
        driverAuthTag: "not-an-auth-tag",
      }),
    ).toThrow(/auth tag JSON array/u);
  });

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
    ).toThrow(/Discord snowflake/u);
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

  it("normalizes Telegram user credential payloads", () => {
    const sha256 = "a".repeat(64);

    expect(
      normalizeCredentialPayloadForKind("telegram-user", {
        groupId: " -100123 ",
        sutToken: " sut-token ",
        testerUserId: " 8709353529 ",
        testerUsername: " OpenClawTestUser ",
        telegramApiId: " 123456 ",
        telegramApiHash: " api-hash ",
        tdlibDatabaseEncryptionKey: " db-key ",
        tdlibArchiveBase64: " tdlib-archive ",
        tdlibArchiveSha256: sha256.toUpperCase(),
        desktopTdataArchiveBase64: " desktop-archive ",
        desktopTdataArchiveSha256: sha256,
        ignored: true,
      }),
    ).toEqual({
      groupId: "-100123",
      sutToken: "sut-token",
      testerUserId: "8709353529",
      testerUsername: "OpenClawTestUser",
      telegramApiId: "123456",
      telegramApiHash: "api-hash",
      tdlibDatabaseEncryptionKey: "db-key",
      tdlibArchiveBase64: "tdlib-archive",
      tdlibArchiveSha256: sha256,
      desktopTdataArchiveBase64: "desktop-archive",
      desktopTdataArchiveSha256: sha256,
    });
  });

  it("rejects malformed Telegram user credential payloads", () => {
    const validPayload = {
      groupId: "-100123",
      sutToken: "sut-token",
      testerUserId: "8709353529",
      testerUsername: "OpenClawTestUser",
      telegramApiId: "123456",
      telegramApiHash: "api-hash",
      tdlibDatabaseEncryptionKey: "db-key",
      tdlibArchiveBase64: "tdlib-archive",
      tdlibArchiveSha256: "a".repeat(64),
      desktopTdataArchiveBase64: "desktop-archive",
      desktopTdataArchiveSha256: "b".repeat(64),
    };

    expect(() =>
      normalizeCredentialPayloadForKind("telegram-user", {
        ...validPayload,
        testerUserId: "tester",
      }),
    ).toThrow(/testerUserId/u);
    expect(() =>
      normalizeCredentialPayloadForKind("telegram-user", {
        ...validPayload,
        tdlibArchiveSha256: "not-sha",
      }),
    ).toThrow(/tdlibArchiveSha256/u);
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
