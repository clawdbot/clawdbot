export const AGENT_BUTTON_KEY = "agent";
export const AGENT_SELECT_KEY = "agentsel";

export {
  ackComponentInteraction,
  resolveAgentComponentRoute,
  resolveComponentInteractionContext,
  resolveDiscordChannelContext,
} from "./agent-components-context.js";
export {
  ensureAgentComponentInteractionAllowed,
  ensureComponentUserAllowed,
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
} from "./agent-components.types.js";
export { resolvePinnedMainDmOwnerFromAllowlist } from "./agent-components-helpers.runtime.js";
