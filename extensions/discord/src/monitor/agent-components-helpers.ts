export const AGENT_BUTTON_KEY = "agent";
export const AGENT_SELECT_KEY = "agentsel";

/**
 * The component custom id only carries the logical button id. Channel binding
 * comes from Discord's trusted interaction payload.
 */
export function buildAgentButtonCustomId(componentId: string): string {
  return `${AGENT_BUTTON_KEY}:componentId=${encodeURIComponent(componentId)}`;
}

export function buildAgentSelectCustomId(componentId: string): string {
  return `${AGENT_SELECT_KEY}:componentId=${encodeURIComponent(componentId)}`;
}

export {
  ackComponentInteraction,
  resolveAgentComponentRoute,
  resolveComponentInteractionContext,
  resolveDiscordChannelContext,
} from "./agent-components-context.js";
export {
  ensureAgentComponentInteractionAllowed,
  ensureComponentUserAllowed,
  ensureGuildComponentMemberAllowed,
  resolveAuthorizedComponentInteraction,
  resolveComponentCommandAuthorized,
  resolveInteractionContextWithDmAuth,
} from "./agent-components-auth.js";
export {
  formatModalSubmissionText,
  mapSelectValues,
  parseAgentComponentData,
  parseDiscordComponentData,
  parseDiscordModalId,
  resolveDiscordInteractionId,
  resolveInteractionCustomId,
  resolveModalFieldValues,
} from "./agent-components-data.js";
export type {
  AgentComponentContext,
  AgentComponentInteraction,
  AgentComponentMessageInteraction,
  ComponentInteractionContext,
  DiscordChannelContext,
  DiscordUser,
} from "./agent-components.types.js";
export { resolveDiscordGuildEntry } from "./allow-list.js";
export { resolvePinnedMainDmOwnerFromAllowlist } from "./agent-components-helpers.runtime.js";
