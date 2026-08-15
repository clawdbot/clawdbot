// Payload Validation module supports OpenClaw QA credential workflows.
import { getPublicKey, nip19 } from "nostr-tools";

class CredentialPayloadValidationError extends Error {
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
const BUZZ_ROOM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BUZZ_PRIVATE_KEY_HEX_RE = /^[0-9a-f]{64}$/iu;
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

function decodeBuzzPrivateKey(value: string) {
  if (BUZZ_PRIVATE_KEY_HEX_RE.test(value)) {
    const bytes = value.match(/.{2}/gu);
    if (bytes?.length === 32) {
      return Uint8Array.from(bytes.map((byte) => Number.parseInt(byte, 16)));
    }
  }
  const decoded = nip19.decode(value);
  if (decoded.type !== "nsec") {
    throw new Error("not a Buzz private key");
  }
  return decoded.data;
}

function requireBuzzPrivateKey(
  payload: Record<string, unknown>,
  key: "driverPrivateKey" | "sutPrivateKey",
  createFailure: PayloadValidationFailureFactory,
) {
  const value = requirePayloadString(payload, key, "buzz", createFailure);
  try {
    return { value, publicKey: getPublicKey(decodeBuzzPrivateKey(value)) };
  } catch {
    return throwPayloadError(
      createFailure,
      `Credential payload for kind "buzz" must include "${key}" as an nsec or 64-character hex private key.`,
    );
  }
}

function requireBuzzAuthTag(
  payload: Record<string, unknown>,
  key: "driverAuthTag" | "sutAuthTag",
  createFailure: PayloadValidationFailureFactory,
) {
  const value = requirePayloadString(payload, key, "buzz", createFailure);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== "auth" ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throwPayloadError(
      createFailure,
      `Credential payload for kind "buzz" must include "${key}" as an auth tag JSON array.`,
    );
  }
  return value;
}

function normalizeBuzzCredentialPayload(
  payload: Record<string, unknown>,
  createFailure: PayloadValidationFailureFactory,
) {
  const kind = "buzz";
  const relayUrl = requirePayloadString(payload, "relayUrl", kind, createFailure);
  let parsedRelayUrl: URL | undefined;
  try {
    parsedRelayUrl = new URL(relayUrl);
  } catch {
    parsedRelayUrl = undefined;
  }
  const relayProtocol = parsedRelayUrl?.protocol;
  const relayUsesSafeTransport =
    relayProtocol === "wss:" ||
    (relayProtocol === "ws:" && isBuzzLoopbackHostname(parsedRelayUrl?.hostname ?? ""));
  if (!relayUsesSafeTransport) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "buzz" must include "relayUrl" using wss:// (ws:// is allowed only for loopback).',
    );
  }
  const roomId = requirePayloadString(payload, "roomId", kind, createFailure).toLowerCase();
  if (!BUZZ_ROOM_ID_RE.test(roomId)) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "buzz" must include "roomId" as a channel UUID.',
    );
  }
  const driverIdentity = requireBuzzPrivateKey(payload, "driverPrivateKey", createFailure);
  const sutIdentity = requireBuzzPrivateKey(payload, "sutPrivateKey", createFailure);
  if (driverIdentity.publicKey === sutIdentity.publicKey) {
    throwPayloadError(
      createFailure,
      'Credential payload for kind "buzz" must use distinct driver and SUT identities.',
    );
  }
  const readOptionalBuzzAuthTag = (key: "driverAuthTag" | "sutAuthTag") => {
    if (payload[key] === undefined) {
      return undefined;
    }
    return requireBuzzAuthTag(payload, key, createFailure);
  };
  const driverAuthTag = readOptionalBuzzAuthTag("driverAuthTag");
  const sutAuthTag = readOptionalBuzzAuthTag("sutAuthTag");

  return {
    relayUrl,
    roomId,
    driverPrivateKey: driverIdentity.value,
    sutPrivateKey: sutIdentity.value,
    ...(driverAuthTag ? { driverAuthTag } : {}),
    ...(sutAuthTag ? { sutAuthTag } : {}),
  } satisfies Record<string, unknown>;
}

function isBuzzLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const octets = ipv4.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
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
  buzz: normalizeBuzzCredentialPayload,
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
