import { z } from "zod";

export const TELEGRAM_USER_QA_CREDENTIAL_KIND = "telegram-user";

const sha256HexSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/u, "must be a SHA-256 hex string");

const numericStringSchema = z.string().trim().regex(/^\d+$/u, "must be a numeric string");

const telegramUserQaCredentialPayloadSchema = z.object({
  groupId: z
    .string()
    .trim()
    .regex(/^-?\d+$/u, "must be a numeric Telegram chat id"),
  sutToken: z.string().trim().min(1),
  testerUserId: numericStringSchema,
  testerUsername: z.string().trim().min(1),
  telegramApiId: numericStringSchema,
  telegramApiHash: z.string().trim().min(1),
  tdlibDatabaseEncryptionKey: z.string().trim().min(1),
  tdlibArchiveBase64: z.string().trim().min(1),
  tdlibArchiveSha256: sha256HexSchema,
  desktopTdataArchiveBase64: z.string().trim().min(1),
  desktopTdataArchiveSha256: sha256HexSchema,
});

export type TelegramUserQaCredentialPayload = z.infer<typeof telegramUserQaCredentialPayloadSchema>;

export function parseTelegramUserQaCredentialPayload(
  payload: unknown,
): TelegramUserQaCredentialPayload {
  return telegramUserQaCredentialPayloadSchema.parse(payload);
}
