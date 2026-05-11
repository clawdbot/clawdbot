export class CredentialPayloadValidationError extends Error {
  code: string;
  httpStatus: number;

  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "CredentialPayloadValidationError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

type PayloadValidationFailureFactory = (httpStatus: number, code: string, message: string) => Error;

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/u;
const E164_RE = /^\+[1-9]\d{6,14}$/u;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;
const TELEGRAM_CHAT_ID_RE = /^-?\d+$/u;
const TELEGRAM_USER_ID_RE = /^\d+$/u;

function createCredentialPayloadValidationError(httpStatus: number, code: string, message: string) {
  return new CredentialPayloadValidationError(httpStatus, code, message);
}

function throwPayloadError(createFailure: PayloadValidationFailureFactory, message: string): never {
  throw createFailure(400, "INVALID_PAYLOAD", message);
}

function requirePayloadString(
  payload: Record<string, unknown>,
  key: string,
  kind: string,
  createFailure: PayloadValidationFailureFactory,
): string {
  const raw = payload[key];
  if (typeof raw !== "string") {
    throwPayloadError(
      createFailure,
      `Credential payload for kind "${kind}" must include "${key}" as a string.`,
    );
  }
  const value = raw.trim();
  if (!value) {
    throwPayloadError(
      createFailure,
      `Credential payload for kind "${kind}" must include a non-empty "${key}" value.`,
    );
  }
  return value;
}

function requireDiscordSnowflakePayloadString(
  payload: Record<string, unknown>,
  key: string,
  createFailure: PayloadValidationFailureFactory,
) {
  const value = requirePayloadString(payload, key, "discord", createFailure);
  if (!DISCORD_SNOWFLAKE_RE.test(value)) {
    throwPayloadError(
      createFailure,
      `Credential payload for kind "discord" must include "${key}" as a Discord snowflake string.`,
    );
  }
  return value;
}

function normalizeTelegramCredentialPayload(
  payload: Record<string, unknown>,
  createFailure: PayloadValidationFailureFactory,
) {
  const groupId = requirePayloadString(payload, "groupId", "telegram", createFailure);
  if (!TELEGRAM_CHAT_ID_RE.test(groupId)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "telegram" must include a numeric "groupId" string.',
    );
  }

  const driverToken = requirePayloadString(payload, "driverToken", "telegram", createFailure);
  const sutToken = requirePayloadString(payload, "sutToken", "telegram", createFailure);

  return {
    groupId,
    driverToken,
    sutToken,
  } satisfies Record<string, unknown>;
}

function normalizeTelegramUserCredentialPayload(
  payload: Record<string, unknown>,
  createFailure: PayloadValidationFailureFactory,
) {
  const kind = "telegram-user";
  const groupId = requirePayloadString(payload, "groupId", kind, createFailure);
  if (!TELEGRAM_CHAT_ID_RE.test(groupId)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "telegram-user" must include a numeric "groupId" string.',
    );
  }
  const testerUserId = requirePayloadString(payload, "testerUserId", kind, createFailure);
  if (!TELEGRAM_USER_ID_RE.test(testerUserId)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "telegram-user" must include a numeric "testerUserId" string.',
    );
  }
  const telegramApiId = requirePayloadString(payload, "telegramApiId", kind, createFailure);
  if (!TELEGRAM_USER_ID_RE.test(telegramApiId)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "telegram-user" must include a numeric "telegramApiId" string.',
    );
  }
  const tdlibArchiveSha256 = requirePayloadString(
    payload,
    "tdlibArchiveSha256",
    kind,
    createFailure,
  ).toLowerCase();
  const desktopTdataArchiveSha256 = requirePayloadString(
    payload,
    "desktopTdataArchiveSha256",
    kind,
    createFailure,
  ).toLowerCase();
  if (!SHA256_HEX_RE.test(tdlibArchiveSha256)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "telegram-user" must include "tdlibArchiveSha256" as a SHA-256 hex string.',
    );
  }
  if (!SHA256_HEX_RE.test(desktopTdataArchiveSha256)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "telegram-user" must include "desktopTdataArchiveSha256" as a SHA-256 hex string.',
    );
  }

  return {
    groupId,
    sutToken: requirePayloadString(payload, "sutToken", kind, createFailure),
    testerUserId,
    testerUsername: requirePayloadString(payload, "testerUsername", kind, createFailure),
    telegramApiId,
    telegramApiHash: requirePayloadString(payload, "telegramApiHash", kind, createFailure),
    tdlibDatabaseEncryptionKey: requirePayloadString(
      payload,
      "tdlibDatabaseEncryptionKey",
      kind,
      createFailure,
    ),
    tdlibArchiveBase64: requirePayloadString(payload, "tdlibArchiveBase64", kind, createFailure),
    tdlibArchiveSha256,
    desktopTdataArchiveBase64: requirePayloadString(
      payload,
      "desktopTdataArchiveBase64",
      kind,
      createFailure,
    ),
    desktopTdataArchiveSha256,
  } satisfies Record<string, unknown>;
}

function normalizeDiscordCredentialPayload(
  payload: Record<string, unknown>,
  createFailure: PayloadValidationFailureFactory,
) {
  const guildId = requireDiscordSnowflakePayloadString(payload, "guildId", createFailure);
  const channelId = requireDiscordSnowflakePayloadString(payload, "channelId", createFailure);
  const sutApplicationId = requireDiscordSnowflakePayloadString(
    payload,
    "sutApplicationId",
    createFailure,
  );
  const voiceChannelId =
    typeof payload.voiceChannelId === "string" && payload.voiceChannelId.trim()
      ? payload.voiceChannelId.trim()
      : undefined;
  if (voiceChannelId && !DISCORD_SNOWFLAKE_RE.test(voiceChannelId)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "discord" must include "voiceChannelId" as a Discord snowflake string when set.',
    );
  }
  const driverBotToken = requirePayloadString(payload, "driverBotToken", "discord", createFailure);
  const sutBotToken = requirePayloadString(payload, "sutBotToken", "discord", createFailure);

  return {
    guildId,
    channelId,
    driverBotToken,
    sutBotToken,
    sutApplicationId,
    ...(voiceChannelId ? { voiceChannelId } : {}),
  } satisfies Record<string, unknown>;
}

function requireE164PayloadString(
  payload: Record<string, unknown>,
  key: string,
  kind: string,
  createFailure: PayloadValidationFailureFactory,
) {
  const value = requirePayloadString(payload, key, kind, createFailure);
  if (!E164_RE.test(value)) {
    throwPayloadError(
      createFailure,
      `Credential payload for kind "${kind}" must include "${key}" as an E.164 phone number string.`,
    );
  }
  return value;
}

function normalizeWhatsAppCredentialPayload(
  payload: Record<string, unknown>,
  createFailure: PayloadValidationFailureFactory,
) {
  const driverPhoneE164 = requireE164PayloadString(
    payload,
    "driverPhoneE164",
    "whatsapp",
    createFailure,
  );
  const sutPhoneE164 = requireE164PayloadString(payload, "sutPhoneE164", "whatsapp", createFailure);
  if (driverPhoneE164 === sutPhoneE164) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "whatsapp" must use distinct driverPhoneE164 and sutPhoneE164 values.',
    );
  }
  const driverAuthArchiveBase64 = requirePayloadString(
    payload,
    "driverAuthArchiveBase64",
    "whatsapp",
    createFailure,
  );
  const sutAuthArchiveBase64 = requirePayloadString(
    payload,
    "sutAuthArchiveBase64",
    "whatsapp",
    createFailure,
  );
  const groupJid =
    typeof payload.groupJid === "string" && payload.groupJid.trim()
      ? payload.groupJid.trim()
      : undefined;

  return {
    driverPhoneE164,
    sutPhoneE164,
    driverAuthArchiveBase64,
    sutAuthArchiveBase64,
    ...(groupJid ? { groupJid } : {}),
  } satisfies Record<string, unknown>;
}

const credentialPayloadNormalizers: Record<
  string,
  (
    payload: Record<string, unknown>,
    createFailure: PayloadValidationFailureFactory,
  ) => Record<string, unknown>
> = {
  discord: normalizeDiscordCredentialPayload,
  telegram: normalizeTelegramCredentialPayload,
  "telegram-user": normalizeTelegramUserCredentialPayload,
  whatsapp: normalizeWhatsAppCredentialPayload,
};

export function normalizeCredentialPayloadForKind(
  kind: string,
  payload: Record<string, unknown>,
  createFailure: PayloadValidationFailureFactory = createCredentialPayloadValidationError,
) {
  return credentialPayloadNormalizers[kind]?.(payload, createFailure) ?? payload;
}
