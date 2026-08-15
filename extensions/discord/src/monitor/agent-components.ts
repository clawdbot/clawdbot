// Discord plugin module implements agent components behavior.
import { Modal, type BaseMessageInteractiveComponent } from "../internal/discord.js";
import type { AgentComponentContext } from "./agent-components-helpers.js";
import { discordComponentControlHandlers } from "./agent-components.handlers.js";
import { DiscordComponentModal } from "./agent-components.modal.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
} from "./agent-components.system-controls.js";
import {
  createDiscordComponentButtonControl,
  createDiscordComponentChannelSelectControl,
  createDiscordComponentMentionableSelectControl,
  createDiscordComponentRoleSelectControl,
  createDiscordComponentStringSelectControl,
  createDiscordComponentUserSelectControl,
  type DiscordComponentControlHandlers,
} from "./agent-components.wildcard-controls.js";

type ComponentFactory = (ctx: AgentComponentContext) => BaseMessageInteractiveComponent;

function bindDiscordComponentControl<T extends BaseMessageInteractiveComponent>(
  createControl: (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) => T,
) {
  return (ctx: AgentComponentContext): T => createControl(ctx, discordComponentControlHandlers);
}

const createDiscordComponentButton = bindDiscordComponentControl(
  createDiscordComponentButtonControl,
);
const createDiscordComponentStringSelect = bindDiscordComponentControl(
  createDiscordComponentStringSelectControl,
);
const createDiscordComponentUserSelect = bindDiscordComponentControl(
  createDiscordComponentUserSelectControl,
);
const createDiscordComponentRoleSelect = bindDiscordComponentControl(
  createDiscordComponentRoleSelectControl,
);
const createDiscordComponentMentionableSelect = bindDiscordComponentControl(
  createDiscordComponentMentionableSelectControl,
);
const createDiscordComponentChannelSelect = bindDiscordComponentControl(
  createDiscordComponentChannelSelectControl,
);

export const createAgentComponentControls = [
  createAgentComponentButton,
  createAgentSelectMenu,
] satisfies readonly ComponentFactory[];

export const createDiscordComponentControls = [
  createDiscordComponentButton,
  createDiscordComponentStringSelect,
  createDiscordComponentUserSelect,
  createDiscordComponentRoleSelect,
  createDiscordComponentMentionableSelect,
  createDiscordComponentChannelSelect,
] satisfies readonly ComponentFactory[];

export function createDiscordComponentModal(ctx: AgentComponentContext): Modal {
  return new DiscordComponentModal(ctx);
}
