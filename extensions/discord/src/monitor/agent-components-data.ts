import { logError } from "openclaw/plugin-sdk/text-runtime";
import {
  parseDiscordComponentCustomId,
  parseDiscordModalCustomId,
} from "../component-custom-id.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import type { ComponentData, ModalInteraction } from "../internal/discord.js";
import type { AgentComponentInteraction } from "./agent-components.types.js";
import { formatDiscordUserTag } from "./format.js";

function readParsedComponentId(data: ComponentData): unknown {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return "cid" in data
    ? (data as Record<string, unknown>).cid
    : (data as Record<string, unknown>).componentId;
}

function normalizeComponentId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function mapOptionLabels(
  options: Array<{ value: string; label: string }> | undefined,
  values: string[],
) {
  if (!options || options.length === 0) {
    return values;
  }
  const map = new Map(options.map((option) => [option.value, option.label]));
  return values.map((value) => map.get(value) ?? value);
}

export function parseAgentComponentData(data: ComponentData): { componentId: string } | null {
  const raw = readParsedComponentId(data);
  const decodeSafe = (value: string): string => {
    if (!value.includes("%")) {
      return value;
    }
    if (!/%[0-9A-Fa-f]{2}/.test(value)) {
      return value;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const componentId =
    typeof raw === "string" ? decodeSafe(raw) : typeof raw === "number" ? String(raw) : null;
  if (!componentId) {
    return null;
  }
  return { componentId };
}

export function parseDiscordComponentData(
  data: ComponentData,
  customId?: string,
): { componentId: string; modalId?: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const rawComponentId = readParsedComponentId(data);
  const rawModalId =
    "mid" in data ? (data as { mid?: unknown }).mid : (data as { modalId?: unknown }).modalId;
  let componentId = normalizeComponentId(rawComponentId);
  let modalId = normalizeComponentId(rawModalId);
  if (!componentId && customId) {
    const parsed = parseDiscordComponentCustomId(customId);
    if (parsed) {
      componentId = parsed.componentId;
      modalId = parsed.modalId;
    }
  }
  if (!componentId) {
    return null;
  }
  return { componentId, modalId };
}

export function parseDiscordModalId(data: ComponentData, customId?: string): string | null {
  if (data && typeof data === "object") {
    const rawModalId =
      "mid" in data ? (data as { mid?: unknown }).mid : (data as { modalId?: unknown }).modalId;
    const modalId = normalizeComponentId(rawModalId);
    if (modalId) {
      return modalId;
    }
  }
  if (customId) {
    return parseDiscordModalCustomId(customId);
  }
  return null;
}

export function resolveInteractionCustomId(
  interaction: AgentComponentInteraction,
): string | undefined {
  if (!interaction?.rawData || typeof interaction.rawData !== "object") {
    return undefined;
  }
  if (!("data" in interaction.rawData)) {
    return undefined;
  }
  const data = (interaction.rawData as { data?: { custom_id?: unknown } }).data;
  const customId = data?.custom_id;
  if (typeof customId !== "string") {
    return undefined;
  }
  const trimmed = customId.trim();
  return trimmed ? trimmed : undefined;
}

export function mapSelectValues(entry: DiscordComponentEntry, values: string[]): string[] {
  if (entry.selectType === "string") {
    return mapOptionLabels(entry.options, values);
  }
  if (entry.selectType === "user") {
    return values.map((value) => `user:${value}`);
  }
  if (entry.selectType === "role") {
    return values.map((value) => `role:${value}`);
  }
  if (entry.selectType === "mentionable") {
    return values.map((value) => `mentionable:${value}`);
  }
  if (entry.selectType === "channel") {
    return values.map((value) => `channel:${value}`);
  }
  return values;
}

export function resolveModalFieldValues(
  field: DiscordModalEntry["fields"][number],
  interaction: ModalInteraction,
): string[] {
  const fields = interaction.fields;
  const optionLabels = field.options?.map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const required = field.required === true;
  try {
    switch (field.type) {
      case "text": {
        const value = required ? fields.getText(field.id, true) : fields.getText(field.id);
        return value ? [value] : [];
      }
      case "select":
      case "checkbox":
      case "radio": {
        const values = required
          ? fields.getStringSelect(field.id, true)
          : (fields.getStringSelect(field.id) ?? []);
        return mapOptionLabels(optionLabels, values);
      }
      case "role-select": {
        try {
          const roles = required
            ? fields.getRoleSelect(field.id, true)
            : (fields.getRoleSelect(field.id) ?? []);
          return roles.map((role) => role.name ?? role.id);
        } catch {
          const values = required
            ? fields.getStringSelect(field.id, true)
            : (fields.getStringSelect(field.id) ?? []);
          return values;
        }
      }
      case "user-select": {
        const users = required
          ? fields.getUserSelect(field.id, true)
          : (fields.getUserSelect(field.id) ?? []);
        return users.map((user) => formatDiscordUserTag(user));
      }
      default:
        return [];
    }
  } catch (err) {
    logError(`agent modal: failed to read field ${field.id}: ${String(err)}`);
    return [];
  }
}

export function formatModalSubmissionText(
  entry: DiscordModalEntry,
  interaction: ModalInteraction,
): string {
  const lines: string[] = [`Form "${entry.title}" submitted.`];
  for (const field of entry.fields) {
    const values = resolveModalFieldValues(field, interaction);
    if (values.length === 0) {
      continue;
    }
    lines.push(`- ${field.label}: ${values.join(", ")}`);
  }
  if (lines.length === 1) {
    lines.push("- (no values)");
  }
  return lines.join("\n");
}

export function resolveDiscordInteractionId(interaction: AgentComponentInteraction): string {
  const rawId =
    interaction.rawData && typeof interaction.rawData === "object" && "id" in interaction.rawData
      ? (interaction.rawData as { id?: unknown }).id
      : undefined;
  if (typeof rawId === "string" && rawId.trim()) {
    return rawId.trim();
  }
  if (typeof rawId === "number" && Number.isFinite(rawId)) {
    return String(rawId);
  }
  return `discord-interaction:${Date.now()}`;
}
