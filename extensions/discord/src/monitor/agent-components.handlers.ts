import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Discord plugin module implements agent components.handlers behavior.
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
  replyUnavailableComponentInteraction,
  resolveAuthorizedComponentInteraction,
  resolveInteractionCustomId,
} from "./agent-components-helpers.js";
import { dispatchDiscordComponentEvent } from "./agent-components.dispatch.js";
import { dispatchPluginDiscordInteractiveEvent } from "./agent-components.plugin-interactive.js";
import type { DiscordComponentControlHandlers } from "./agent-components.wildcard-controls.js";

const loadComponentsRuntime = createLazyRuntimeModule(() => import("../components.js"));

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
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This component is no longer valid.",
    );
    return;
  }

  const entry = await resolveDiscordComponentEntryWithPersistence({
    id: parsed.componentId,
    consume: false,
  });
  if (!entry) {
    await replyUnavailableComponentInteraction(params.interaction, "This component has expired.");
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
    ctx,
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
    await replyUnavailableComponentInteraction(params.interaction, "This component has expired.");
    return;
  }

  if (consumed.kind === "modal-trigger") {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This form is no longer available.",
    );
    return;
  }

  const values = params.values ? mapSelectValues(consumed, params.values) : undefined;
  const selectedCallbackData =
    consumed.kind === "select" &&
    consumed.callbackDataKind === "callback" &&
    params.values?.length === 1
      ? params.values[0]?.trim()
      : undefined;
  const pluginCallbackData = consumed.callbackData ?? selectedCallbackData;
  if (pluginCallbackData) {
    const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
      ctx,
      interaction: params.interaction,
      interactionCtx,
      channelCtx,
      isAuthorizedSender: commandAuthorized,
      data: pluginCallbackData,
      kind: consumed.kind === "select" ? "select" : "button",
      values,
      messageId: consumed.messageId ?? params.interaction.message?.id,
    });
    if (pluginDispatch === "handled") {
      return;
    }
  }
  // Command actions opt into synthetic command fallback. Opaque callback actions
  // are plugin data only; falling through as slash commands would execute data.
  const buttonCallbackFallback =
    consumed.kind === "button" && consumed.callbackDataKind !== "callback"
      ? consumed.callbackData?.trim()
      : undefined;
  const selectedCommandFallback =
    consumed.kind === "select" &&
    consumed.callbackDataKind === "command" &&
    params.values?.length === 1
      ? params.values[0]?.trim()
      : undefined;
  const eventText =
    buttonCallbackFallback ||
    selectedCommandFallback ||
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
    ctx,
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
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This button is no longer valid.",
    );
    return;
  }
  const entry = await resolveDiscordComponentEntryWithPersistence({
    id: parsed.componentId,
    consume: false,
  });
  if (!entry || entry.kind !== "modal-trigger") {
    await replyUnavailableComponentInteraction(params.interaction, "This button has expired.");
    return;
  }

  const modalId = entry.modalId ?? parsed.modalId;
  if (!modalId) {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This form is no longer available.",
    );
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
    await replyUnavailableComponentInteraction(params.interaction, "This form has expired.");
    return;
  }

  const resolvedModalId = consumed.modalId ?? modalId;
  const modalEntry = await resolveDiscordModalEntryWithPersistence({
    id: resolvedModalId,
    consume: false,
  });
  if (!modalEntry) {
    await replyUnavailableComponentInteraction(params.interaction, "This form has expired.");
    return;
  }

  try {
    await params.interaction.showModal(
      (await loadComponentsRuntime()).createDiscordFormModal(modalEntry),
    );
  } catch (err) {
    logError(`${params.label}: failed to show modal: ${String(err)}`);
    await replyUnavailableComponentInteraction(
      params.interaction,
      "Could not open this form. Request a new form and try again.",
    );
  }
}

export const discordComponentControlHandlers: DiscordComponentControlHandlers = {
  handleComponentEvent: handleDiscordComponentEvent,
  handleModalTrigger: handleDiscordModalTrigger,
};
