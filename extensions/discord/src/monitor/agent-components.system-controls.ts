// Discord plugin module implements agent components.system controls behavior.
import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import { logDebug, logError } from "openclaw/plugin-sdk/logging-core";
import {
  Button,
  StringSelectMenu,
  type ButtonInteraction,
  type ComponentData,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import {
  AGENT_BUTTON_KEY,
  AGENT_SELECT_KEY,
  ackComponentInteraction,
  ensureAgentComponentInteractionAllowed,
  parseAgentComponentData,
  resolveAgentComponentRoute,
  resolveInteractionContextWithDmAuth,
  type AgentComponentContext,
  type AgentComponentMessageInteraction,
} from "./agent-components-helpers.js";
import { enqueueSystemEvent } from "./agent-components.deps.runtime.js";

type AgentSystemControlParams = {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  label: string;
  interactionComponentLabel: string;
  authorizationComponentLabel: string;
  invalidReply: string;
  unauthorizedReply: string;
  contextKeyPrefix: string;
  formatEventText: (params: { componentId: string; username: string; userId: string }) => string;
};

async function runAgentSystemControlInteraction(params: AgentSystemControlParams): Promise<void> {
  const parsed = parseAgentComponentData(params.data);
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    try {
      await params.interaction.reply({
        content: params.invalidReply,
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const { componentId } = parsed;
  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.interactionComponentLabel,
    defer: false,
  });
  if (!interactionCtx) {
    return;
  }
  const {
    channelId,
    user,
    username,
    userId,
    replyOpts,
    rawGuildId,
    isDirectMessage,
    isGroupDm,
    memberRoleIds,
  } = interactionCtx;

  const allowed = await ensureAgentComponentInteractionAllowed({
    ctx: params.ctx,
    interaction: params.interaction,
    channelId,
    rawGuildId,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: params.authorizationComponentLabel,
    unauthorizedReply: params.unauthorizedReply,
  });
  if (!allowed) {
    return;
  }

  const route = resolveAgentComponentRoute({
    ctx: params.ctx,
    rawGuildId,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    userId,
    channelId,
    parentId: allowed.parentId,
  });

  const eventText = params.formatEventText({ componentId, username, userId });
  logDebug(`${params.label}: enqueuing event for channel ${channelId}: ${eventText}`);

  enqueueSystemEvent(eventText, {
    sessionKey: route.sessionKey,
    contextKey: `${params.contextKeyPrefix}:${channelId}:${componentId}:${userId}`,
  });

  await ackComponentInteraction({
    interaction: params.interaction,
    replyOpts,
    label: params.label,
  });
}

class AgentComponentButton extends Button {
  override label = AGENT_BUTTON_KEY;
  customId = `${AGENT_BUTTON_KEY}:seed=1`;
  override style = ButtonStyle.Primary;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  override async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    await runAgentSystemControlInteraction({
      ctx: this.ctx,
      interaction,
      data,
      label: "agent button",
      interactionComponentLabel: "button",
      authorizationComponentLabel: "button",
      invalidReply: "This button is no longer valid.",
      unauthorizedReply: "You are not authorized to use this button.",
      contextKeyPrefix: "discord:agent-button",
      formatEventText: ({ componentId, username, userId }) =>
        `[Discord component: ${componentId} clicked by ${username} (${userId})]`,
    });
  }
}

class AgentSelectMenu extends StringSelectMenu {
  customId = `${AGENT_SELECT_KEY}:seed=1`;
  options: APIStringSelectComponent["options"] = [];
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  override async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    const values = interaction.values ?? [];
    const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";
    await runAgentSystemControlInteraction({
      ctx: this.ctx,
      interaction,
      data,
      label: "agent select",
      interactionComponentLabel: "select menu",
      authorizationComponentLabel: "select",
      invalidReply: "This select menu is no longer valid.",
      unauthorizedReply: "You are not authorized to use this select menu.",
      contextKeyPrefix: "discord:agent-select",
      formatEventText: ({ componentId, username, userId }) =>
        `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`,
    });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}
