import { logError } from "openclaw/plugin-sdk/logging-core";
import {
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "../components-registry.js";
import type { ButtonInteraction, ComponentData } from "../internal/discord.js";
import {
  type AgentComponentContext,
  type AgentComponentMessageInteraction,
  ensureComponentUserAllowed,
  mapSelectValues,
  parseDiscordComponentData,
  resolveAuthorizedComponentInteraction,
  resolveInteractionCustomId,
} from "./agent-components-helpers.js";
import { dispatchDiscordComponentEvent } from "./agent-components.dispatch.js";
import { dispatchPluginDiscordInteractiveEvent } from "./agent-components.plugin-interactive.js";
import type { DiscordComponentControlHandlers } from "./agent-components.wildcard-controls.js";

let componentsRuntimePromise: Promise<typeof import("../components.js")> | undefined;

async function loadComponentsRuntime() {
  componentsRuntimePromise ??= import("../components.js");
  return await componentsRuntimePromise;
}

async function handleDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  componentLabel: string;
  values?: string[];
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    try {
      await params.interaction.reply({
        content: "This component is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const entry = await resolveDiscordComponentEntryWithPersistence({
    id: parsed.componentId,
    consume: false,
  });
  if (!entry) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const unauthorizedReply = `You are not authorized to use this ${params.componentLabel}.`;
  const authorized = await resolveAuthorizedComponentInteraction({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.componentLabel,
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

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply,
    allowNameMatching,
  });
  if (!componentAllowed) {
    return;
  }
  const consumed = await resolveDiscordComponentEntryWithPersistence({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  if (consumed.kind === "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const values = params.values ? mapSelectValues(consumed, params.values) : undefined;
  if (consumed.callbackData) {
    const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
      ctx: params.ctx,
      interaction: params.interaction,
      interactionCtx,
      channelCtx,
      isAuthorizedSender: commandAuthorized,
      data: consumed.callbackData,
      kind: consumed.kind === "select" ? "select" : "button",
      values,
      messageId: consumed.messageId ?? params.interaction.message?.id,
    });
    if (pluginDispatch === "handled") {
      return;
    }
  }
  // Preserve explicit callback payloads for button fallbacks so Discord
  // behaves like Telegram when buttons carry synthetic command text. Select
  // fallbacks still need their chosen values in the synthesized event text.
  const eventText =
    (consumed.kind === "button" ? consumed.callbackData?.trim() : undefined) ||
    (await loadComponentsRuntime()).formatDiscordComponentEventText({
      kind: consumed.kind === "select" ? "select" : "button",
      label: consumed.label,
      values,
    });

  try {
    await params.interaction.reply({ content: "✓", ...replyOpts });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }

  await dispatchDiscordComponentEvent({
    ctx: params.ctx,
    interaction: params.interaction,
    interactionCtx,
    channelCtx,
    guildInfo,
    eventText,
    replyToId: consumed.messageId ?? params.interaction.message?.id,
    routeOverrides: {
      sessionKey: consumed.sessionKey,
      agentId: consumed.agentId,
      accountId: consumed.accountId,
    },
  });
}

async function handleDiscordModalTrigger(params: {
  ctx: AgentComponentContext;
  interaction: ButtonInteraction;
  data: ComponentData;
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse modal trigger data`);
    try {
      await params.interaction.reply({
        content: "This button is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }
  const entry = await resolveDiscordComponentEntryWithPersistence({
    id: parsed.componentId,
    consume: false,
  });
  if (!entry || entry.kind !== "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This button has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const modalId = entry.modalId ?? parsed.modalId;
  if (!modalId) {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const unauthorizedReply = "You are not authorized to use this form.";
  const authorized = await resolveAuthorizedComponentInteraction({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: "form",
    unauthorizedReply,
    defer: false,
  });
  if (!authorized) {
    return;
  }
  const { user, replyOpts, allowNameMatching } = authorized;

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: "form",
    unauthorizedReply,
    allowNameMatching,
  });
  if (!componentAllowed) {
    return;
  }

  const consumed = await resolveDiscordComponentEntryWithPersistence({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const resolvedModalId = consumed.modalId ?? modalId;
  const modalEntry = await resolveDiscordModalEntryWithPersistence({
    id: resolvedModalId,
    consume: false,
  });
  if (!modalEntry) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  try {
    await params.interaction.showModal(
      (await loadComponentsRuntime()).createDiscordFormModal(modalEntry),
    );
  } catch (err) {
    logError(`${params.label}: failed to show modal: ${String(err)}`);
  }
}

export const discordComponentControlHandlers: DiscordComponentControlHandlers = {
  handleComponentEvent: handleDiscordComponentEvent,
  handleModalTrigger: handleDiscordModalTrigger,
};
