import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import { logDebug, logError } from "openclaw/plugin-sdk/text-runtime";
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
} from "./agent-components-helpers.js";
import { enqueueSystemEvent } from "./agent-components.deps.runtime.js";

export class AgentComponentButton extends Button {
  label = AGENT_BUTTON_KEY;
  customId = `${AGENT_BUTTON_KEY}:seed=1`;
  style = ButtonStyle.Primary;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent button: failed to parse component data");
      try {
        await interaction.reply({
          content: "This button is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "agent button",
      componentLabel: "button",
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
      ctx: this.ctx,
      interaction,
      channelId,
      rawGuildId,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "button",
      unauthorizedReply: "You are not authorized to use this button.",
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    const route = resolveAgentComponentRoute({
      ctx: this.ctx,
      rawGuildId,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      userId,
      channelId,
      parentId,
    });

    const eventText = `[Discord component: ${componentId} clicked by ${username} (${userId})]`;

    logDebug(`agent button: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      sessionKey: route.sessionKey,
      contextKey: `discord:agent-button:${channelId}:${componentId}:${userId}`,
    });

    await ackComponentInteraction({ interaction, replyOpts, label: "agent button" });
  }
}

export class AgentSelectMenu extends StringSelectMenu {
  customId = `${AGENT_SELECT_KEY}:seed=1`;
  options: APIStringSelectComponent["options"] = [];
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent select: failed to parse component data");
      try {
        await interaction.reply({
          content: "This select menu is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "agent select",
      componentLabel: "select menu",
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
      ctx: this.ctx,
      interaction,
      channelId,
      rawGuildId,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "select",
      unauthorizedReply: "You are not authorized to use this select menu.",
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    const values = interaction.values ?? [];
    const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";

    const route = resolveAgentComponentRoute({
      ctx: this.ctx,
      rawGuildId,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      userId,
      channelId,
      parentId,
    });

    const eventText = `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`;

    logDebug(`agent select: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      sessionKey: route.sessionKey,
      contextKey: `discord:agent-select:${channelId}:${componentId}:${userId}`,
    });

    await ackComponentInteraction({ interaction, replyOpts, label: "agent select" });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}
