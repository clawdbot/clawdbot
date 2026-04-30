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

export { resolveDiscordComponentOriginatingTo } from "./agent-components.dispatch.js";
export {
  AgentComponentButton,
  AgentSelectMenu,
  createAgentComponentButton,
  createAgentSelectMenu,
} from "./agent-components.system-controls.js";

type ComponentFactory = (ctx: AgentComponentContext) => BaseMessageInteractiveComponent;

function bindDiscordComponentControl<T extends BaseMessageInteractiveComponent>(
  createControl: (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) => T,
) {
  return (ctx: AgentComponentContext): T => createControl(ctx, discordComponentControlHandlers);
}

export const createDiscordComponentButton = bindDiscordComponentControl(
  createDiscordComponentButtonControl,
);
export const createDiscordComponentStringSelect = bindDiscordComponentControl(
  createDiscordComponentStringSelectControl,
);
export const createDiscordComponentUserSelect = bindDiscordComponentControl(
  createDiscordComponentUserSelectControl,
);
export const createDiscordComponentRoleSelect = bindDiscordComponentControl(
  createDiscordComponentRoleSelectControl,
);
export const createDiscordComponentMentionableSelect = bindDiscordComponentControl(
  createDiscordComponentMentionableSelectControl,
);
export const createDiscordComponentChannelSelect = bindDiscordComponentControl(
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
