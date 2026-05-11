import { describe, expect, it } from "vitest";
import {
  TELEGRAM_USER_QA_CREDENTIAL_KIND,
  parseTelegramUserQaCredentialPayload,
} from "./telegram-user-credential.runtime.js";

describe("Telegram user QA credential payload", () => {
  it("parses the account-wide CLI and Desktop credential shape", () => {
    const sha256 = "a".repeat(64);

    expect(
      parseTelegramUserQaCredentialPayload({
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
    expect(TELEGRAM_USER_QA_CREDENTIAL_KIND).toBe("telegram-user");
  });

  it("rejects malformed payloads", () => {
    expect(() =>
      parseTelegramUserQaCredentialPayload({
        groupId: "-100123",
        sutToken: "sut-token",
        testerUserId: "not-a-user-id",
        testerUsername: "OpenClawTestUser",
        telegramApiId: "123456",
        telegramApiHash: "api-hash",
        tdlibDatabaseEncryptionKey: "db-key",
        tdlibArchiveBase64: "tdlib-archive",
        tdlibArchiveSha256: "a".repeat(64),
        desktopTdataArchiveBase64: "desktop-archive",
        desktopTdataArchiveSha256: "b".repeat(64),
      }),
    ).toThrow(/numeric string/u);
  });
});
