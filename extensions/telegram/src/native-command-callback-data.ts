// Telegram plugin module implements native command callback data behavior.
const TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX = "tgcmd:";
const TELEGRAM_OPAQUE_CALLBACK_PREFIX = "tgcb1:";

export function buildTelegramNativeCommandCallbackData(commandText: string): string {
  return `${TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX}${commandText}`;
}

export function parseTelegramNativeCommandCallbackData(data?: string | null): string | null {
  if (!data) {
    return null;
  }
  const trimmed = data.trim();
  if (!trimmed.startsWith(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX)) {
    return null;
  }
  const commandText = trimmed.slice(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX.length).trim();
  return commandText.startsWith("/") ? commandText : null;
}

export function buildTelegramOpaqueCallbackData(value: string): string {
  return `${TELEGRAM_OPAQUE_CALLBACK_PREFIX}${checksumTelegramOpaqueCallbackValue(value)}:${value}`;
}

export function parseTelegramOpaqueCallbackData(data?: string | null): string | null {
  if (!data) {
    return null;
  }
  if (!data.startsWith(TELEGRAM_OPAQUE_CALLBACK_PREFIX)) {
    return null;
  }
  const encoded = data.slice(TELEGRAM_OPAQUE_CALLBACK_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const checksum = encoded.slice(0, separatorIndex);
  const value = encoded.slice(separatorIndex + 1);
  if (!value || checksum !== checksumTelegramOpaqueCallbackValue(value)) {
    return null;
  }
  return value;
}

function checksumTelegramOpaqueCallbackValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 5).padStart(5, "0");
}
