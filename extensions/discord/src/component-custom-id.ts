// Discord plugin module implements component custom id behavior.
import {
  escapeCustomIdFieldValue,
  needsCustomIdFieldEscaping,
  unescapeCustomIdFieldValue,
} from "./custom-id-codec.js";
import { parseCustomId, type ComponentParserResult } from "./internal/discord.js";

export const DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
export const DISCORD_MODAL_CUSTOM_ID_KEY = "ocmodal";
const DISCORD_ACTIVITY_CUSTOM_ID_KEY = "ocactivity";
const ENCODED_CUSTOM_ID_VERSION = "1";

export function buildDiscordActivityCustomId(widgetId: string): string {
  return `${DISCORD_ACTIVITY_CUSTOM_ID_KEY}:v=${ENCODED_CUSTOM_ID_VERSION};wid=${widgetId}`;
}

export function parseDiscordActivityCustomId(id: string): { widgetId: string } | null {
  const parsed = parseCustomId(id);
  if (
    parsed.key !== DISCORD_ACTIVITY_CUSTOM_ID_KEY ||
    parsed.data.v !== ENCODED_CUSTOM_ID_VERSION ||
    typeof parsed.data.wid !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(parsed.data.wid)
  ) {
    return null;
  }
  return { widgetId: parsed.data.wid };
}

export function parseDiscordActivityCustomIdForInteraction(id: string): ComponentParserResult {
  const parsed = parseDiscordActivityCustomId(id);
  return parsed
    ? { key: DISCORD_ACTIVITY_CUSTOM_ID_KEY, data: { widgetId: parsed.widgetId } }
    : parseCustomId(id);
}

function decodeParsedCustomIdData(
  data: ComponentParserResult["data"],
): ComponentParserResult["data"] {
  if (data.e !== ENCODED_CUSTOM_ID_VERSION) {
    return data;
  }
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? unescapeCustomIdFieldValue(value) : value,
    ]),
  ) as ComponentParserResult["data"];
}

export function buildDiscordComponentCustomId(params: {
  componentId: string;
  modalId?: string;
}): string {
  const encoded =
    needsCustomIdFieldEscaping(params.componentId) ||
    needsCustomIdFieldEscaping(params.modalId ?? "");
  const componentId = encoded ? escapeCustomIdFieldValue(params.componentId) : params.componentId;
  const base = encoded
    ? `${DISCORD_COMPONENT_CUSTOM_ID_KEY}:e=${ENCODED_CUSTOM_ID_VERSION};cid=${componentId}`
    : `${DISCORD_COMPONENT_CUSTOM_ID_KEY}:cid=${componentId}`;
  const modalId = params.modalId;
  if (!modalId) {
    return base;
  }
  return `${base};mid=${encoded ? escapeCustomIdFieldValue(modalId) : modalId}`;
}

export function buildDiscordModalCustomId(modalId: string): string {
  return needsCustomIdFieldEscaping(modalId)
    ? `${DISCORD_MODAL_CUSTOM_ID_KEY}:e=${ENCODED_CUSTOM_ID_VERSION};mid=${escapeCustomIdFieldValue(modalId)}`
    : `${DISCORD_MODAL_CUSTOM_ID_KEY}:mid=${modalId}`;
}

export function parseDiscordComponentCustomId(
  id: string,
): { componentId: string; modalId?: string } | null {
  const parsed = parseCustomId(id);
  if (parsed.key !== DISCORD_COMPONENT_CUSTOM_ID_KEY) {
    return null;
  }
  const data = decodeParsedCustomIdData(parsed.data);
  const componentId = data.cid;
  if (typeof componentId !== "string" || !componentId.trim()) {
    return null;
  }
  const modalId = data.mid;
  return {
    componentId,
    modalId: typeof modalId === "string" && modalId.trim() ? modalId : undefined,
  };
}

export function parseDiscordModalCustomId(id: string): string | null {
  const parsed = parseCustomId(id);
  if (parsed.key !== DISCORD_MODAL_CUSTOM_ID_KEY) {
    return null;
  }
  const data = decodeParsedCustomIdData(parsed.data);
  const modalId = data.mid;
  if (typeof modalId !== "string" || !modalId.trim()) {
    return null;
  }
  return modalId;
}

function isDiscordComponentWildcardRegistrationId(id: string): boolean {
  return /^__openclaw_discord_component_[a-z_]+_wildcard__$/.test(id);
}

export function parseDiscordComponentCustomIdForInteraction(id: string): ComponentParserResult {
  if (id === "*" || isDiscordComponentWildcardRegistrationId(id)) {
    return { key: "*", data: {} };
  }
  const parsed = parseCustomId(id);
  if (parsed.key !== DISCORD_COMPONENT_CUSTOM_ID_KEY) {
    return parsed;
  }
  return { key: "*", data: decodeParsedCustomIdData(parsed.data) };
}

export function parseDiscordModalCustomIdForInteraction(id: string): ComponentParserResult {
  if (id === "*" || isDiscordComponentWildcardRegistrationId(id)) {
    return { key: "*", data: {} };
  }
  const parsed = parseCustomId(id);
  if (parsed.key !== DISCORD_MODAL_CUSTOM_ID_KEY) {
    return parsed;
  }
  return { key: "*", data: decodeParsedCustomIdData(parsed.data) };
}
