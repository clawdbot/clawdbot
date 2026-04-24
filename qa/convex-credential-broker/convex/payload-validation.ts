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
const TELEGRAM_CHAT_ID_RE = /^-?\d+$/u;

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
  const driverBotToken = requirePayloadString(payload, "driverBotToken", "discord", createFailure);
  const sutBotToken = requirePayloadString(payload, "sutBotToken", "discord", createFailure);

  return {
    guildId,
    channelId,
    driverBotToken,
    sutBotToken,
    sutApplicationId,
  } satisfies Record<string, unknown>;
}

export function normalizeCredentialPayloadForKind(
  kind: string,
  payload: Record<string, unknown>,
  createFailure: PayloadValidationFailureFactory = createCredentialPayloadValidationError,
) {
  if (kind === "telegram") {
    return normalizeTelegramCredentialPayload(payload, createFailure);
  }
  if (kind === "discord") {
    return normalizeDiscordCredentialPayload(payload, createFailure);
  }
  return payload;
}
