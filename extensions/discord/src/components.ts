export {
  DISCORD_COMPONENT_CUSTOM_ID_KEY,
  DISCORD_MODAL_CUSTOM_ID_KEY,
  buildDiscordComponentCustomId,
  buildDiscordModalCustomId,
  parseDiscordComponentCustomId,
  parseDiscordComponentCustomIdForInteraction,
  parseDiscordModalCustomId,
  parseDiscordModalCustomIdForInteraction,
} from "./component-custom-id.js";
export {
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
} from "./components.builders.js";
export {
  DISCORD_COMPONENT_ATTACHMENT_PREFIX,
  readDiscordComponentSpec,
  resolveDiscordComponentAttachmentName,
} from "./components.parse.js";
export { DiscordFormModal, createDiscordFormModal } from "./components.modal.js";
export type {
  DiscordComponentBlock,
  DiscordComponentBuildResult,
  DiscordComponentButtonSpec,
  DiscordComponentButtonStyle,
  DiscordComponentEntry,
  DiscordComponentMessageSpec,
  DiscordComponentModalFieldType,
  DiscordComponentSectionAccessory,
  DiscordComponentSelectOption,
  DiscordComponentSelectSpec,
  DiscordComponentSelectType,
  DiscordModalEntry,
  DiscordModalFieldDefinition,
  DiscordModalFieldSpec,
  DiscordModalSpec,
} from "./components.types.js";
export { buildDiscordInteractiveComponents } from "./shared-interactive.js";
export { Modal, type ComponentData } from "./internal/discord.js";

export function formatDiscordComponentEventText(params: {
  kind: "button" | "select";
  label: string;
  values?: string[];
}): string {
  if (params.kind === "button") {
    return `Clicked "${params.label}".`;
  }
  const values = params.values ?? [];
  if (values.length === 0) {
    return `Updated "${params.label}".`;
  }
  return `Selected ${values.join(", ")} from "${params.label}".`;
}
