import { parseCustomId, type ComponentParserResult } from "./internal/discord.js";

export const DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
export const DISCORD_MODAL_CUSTOM_ID_KEY = "ocmodal";

export function buildDiscordComponentCustomId(params: {
  componentId: string;
  modalId?: string;
}): string {
  const base = `${DISCORD_COMPONENT_CUSTOM_ID_KEY}:cid=${params.componentId}`;
  return params.modalId ? `${base};mid=${params.modalId}` : base;
}

export function buildDiscordModalCustomId(modalId: string): string {
  return `${DISCORD_MODAL_CUSTOM_ID_KEY}:mid=${modalId}`;
}

export function parseDiscordComponentCustomId(
  id: string,
): { componentId: string; modalId?: string } | null {
  const parsed = parseCustomId(id);
  if (parsed.key !== DISCORD_COMPONENT_CUSTOM_ID_KEY) {
    return null;
  }
  const componentId = parsed.data.cid;
  if (typeof componentId !== "string" || !componentId.trim()) {
    return null;
  }
  const modalId = parsed.data.mid;
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
  const modalId = parsed.data.mid;
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
  return { key: "*", data: parsed.data };
}

export function parseDiscordModalCustomIdForInteraction(id: string): ComponentParserResult {
  if (id === "*" || isDiscordComponentWildcardRegistrationId(id)) {
    return { key: "*", data: {} };
  }
  const parsed = parseCustomId(id);
  if (parsed.key !== DISCORD_MODAL_CUSTOM_ID_KEY) {
    return parsed;
  }
  return { key: "*", data: parsed.data };
}
