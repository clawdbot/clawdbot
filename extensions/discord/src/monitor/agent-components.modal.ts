import { logError } from "openclaw/plugin-sdk/text-runtime";
import { parseDiscordModalCustomIdForInteraction } from "../component-custom-id.js";
import { resolveDiscordModalEntry } from "../components-registry.js";
import { Modal, type ComponentData, type ModalInteraction } from "../internal/discord.js";
import {
  type AgentComponentContext,
  ensureComponentUserAllowed,
  formatModalSubmissionText,
  parseDiscordModalId,
  resolveAuthorizedComponentInteraction,
  resolveInteractionCustomId,
  resolveModalFieldValues,
} from "./agent-components-helpers.js";
import { dispatchDiscordComponentEvent } from "./agent-components.dispatch.js";
import { dispatchPluginDiscordInteractiveEvent } from "./agent-components.plugin-interactive.js";

export class DiscordComponentModal extends Modal {
  title = "OpenClaw form";
  customId = "__openclaw_discord_component_modal_wildcard__";
  components = [];
  customIdParser = parseDiscordModalCustomIdForInteraction;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ModalInteraction, data: ComponentData): Promise<void> {
    const modalId = parseDiscordModalId(data, resolveInteractionCustomId(interaction));
    if (!modalId) {
      logError("discord component modal: missing modal id");
      try {
        await interaction.reply({
          content: "This form is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const modalEntry = resolveDiscordModalEntry({ id: modalId, consume: false });
    if (!modalEntry) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const unauthorizedReply = "You are not authorized to use this form.";
    const authorized = await resolveAuthorizedComponentInteraction({
      ctx: this.ctx,
      interaction,
      label: "discord component modal",
      componentLabel: "form",
      unauthorizedReply,
      defer: false,
    });
    if (!authorized) {
      return;
    }
    const {
      interactionCtx,
      channelCtx,
      guildInfo,
      allowNameMatching,
      commandAuthorized,
      user,
      replyOpts,
    } = authorized;

    const modalAllowed = await ensureComponentUserAllowed({
      entry: {
        id: modalEntry.id,
        kind: "button",
        label: modalEntry.title,
        allowedUsers: modalEntry.allowedUsers,
      },
      interaction,
      user,
      replyOpts,
      componentLabel: "form",
      unauthorizedReply,
      allowNameMatching,
    });
    if (!modalAllowed) {
      return;
    }

    const consumed = resolveDiscordModalEntry({
      id: modalId,
      consume: !modalEntry.reusable,
    });
    if (!consumed) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    if (consumed.callbackData) {
      const fields = consumed.fields.map((field) => ({
        id: field.id,
        name: field.name,
        values: resolveModalFieldValues(field, interaction),
      }));
      const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
        ctx: this.ctx,
        interaction,
        interactionCtx,
        channelCtx,
        isAuthorizedSender: commandAuthorized,
        data: consumed.callbackData,
        kind: "modal",
        fields,
        messageId: consumed.messageId,
      });
      if (pluginDispatch === "handled") {
        return;
      }
    }

    try {
      await interaction.acknowledge();
    } catch (err) {
      logError(`discord component modal: failed to acknowledge: ${String(err)}`);
    }

    const eventText = formatModalSubmissionText(consumed, interaction);
    await dispatchDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      interactionCtx,
      channelCtx,
      guildInfo,
      eventText,
      replyToId: consumed.messageId,
      routeOverrides: {
        sessionKey: consumed.sessionKey,
        agentId: consumed.agentId,
        accountId: consumed.accountId,
      },
    });
  }
}
