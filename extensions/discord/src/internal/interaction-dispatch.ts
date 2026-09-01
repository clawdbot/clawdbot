// Discord plugin module implements interaction dispatch behavior.
import { InteractionType, type APIInteraction } from "discord-api-types/v10";
import {
  type DiscordCommand,
  deferCommandInteractionIfNeeded,
  resolveFocusedCommandOptionAutocompleteHandler,
} from "./commands.js";
import type { InteractionResponseState } from "./interaction-response.js";
import {
  AutocompleteInteraction,
  BaseComponentInteraction,
  CommandInteraction,
  ModalInteraction,
  createInteraction,
  parseComponentInteractionData,
  type RawInteraction,
} from "./interactions.js";

type DispatchComponent = {
  defer: boolean | ((interaction: BaseComponentInteraction) => boolean);
  ephemeral: boolean | ((interaction: BaseComponentInteraction) => boolean);
  run(interaction: BaseComponentInteraction, data: Record<string, unknown>): unknown;
  customIdParser(id: string): { data: Record<string, unknown> };
};

type DispatchModal = {
  run(interaction: ModalInteraction, data: Record<string, unknown>): unknown;
  customIdParser(id: string): { data: Record<string, unknown> };
};

type DispatchClient = Parameters<typeof createInteraction>[0] & {
  commands: DiscordCommand[];
  componentHandler: {
    resolve(customId: string, options?: { componentType?: number }): DispatchComponent | undefined;
    resolveOneOffComponent(params: {
      channelId?: string;
      customId: string;
      messageId?: string;
      values?: string[];
    }): boolean;
  };
  modalHandler: { resolve(customId: string): DispatchModal | undefined };
};

export async function dispatchInteraction(
  client: DispatchClient,
  rawData: APIInteraction,
): Promise<void> {
  const interaction = createInteraction(client, rawData as RawInteraction);
  if (rawData.type === InteractionType.ApplicationCommandAutocomplete) {
    const command = client.commands.find((entry) => entry.name === readInteractionName(rawData));
    if (!command) {
      return;
    }
    const autocompleteInteraction = interaction as AutocompleteInteraction;
    const optionAutocomplete = resolveFocusedCommandOptionAutocompleteHandler(
      command,
      autocompleteInteraction,
    );
    if (optionAutocomplete) {
      await optionAutocomplete(autocompleteInteraction);
      return;
    }
    if (command.commandKind === "leaf") {
      await command.autocomplete(autocompleteInteraction);
    }
    return;
  }
  try {
    await dispatchAcknowledgeableInteraction(client, rawData, interaction);
  } catch (error) {
    // A handler that throws after deferring leaves Discord showing a spinner
    // forever, so surface the failure before rethrowing for the caller's log.
    await reportInteractionFailure(interaction);
    throw error;
  }
}

async function dispatchAcknowledgeableInteraction(
  client: DispatchClient,
  rawData: APIInteraction,
  interaction: ReturnType<typeof createInteraction>,
): Promise<void> {
  if (rawData.type === InteractionType.ApplicationCommand) {
    const command = client.commands.find((entry) => entry.name === readInteractionName(rawData));
    if (command) {
      await deferCommandInteractionIfNeeded(command, interaction as CommandInteraction);
      await command.run(interaction as CommandInteraction);
    }
    return;
  }
  if (rawData.type === InteractionType.MessageComponent) {
    const customId = readCustomId(rawData);
    if (!customId) {
      return;
    }
    const componentInteraction = interaction as BaseComponentInteraction;
    if (
      client.componentHandler.resolveOneOffComponent({
        channelId: readMessageChannelId(rawData),
        customId,
        messageId: readMessageId(rawData),
        values: readComponentValues(rawData),
      })
    ) {
      await componentInteraction.acknowledge();
      return;
    }
    const component = client.componentHandler.resolve(customId, {
      componentType: (rawData as { data?: { component_type?: number } }).data?.component_type,
    });
    if (component) {
      await deferComponentInteractionIfNeeded(component, componentInteraction);
      await component.run(componentInteraction, parseComponentInteractionData(component, customId));
    }
    return;
  }
  if (rawData.type === InteractionType.ModalSubmit) {
    const customId = readCustomId(rawData);
    if (!customId) {
      return;
    }
    const modal = client.modalHandler.resolve(customId);
    if (modal) {
      await modal.run(interaction as ModalInteraction, modal.customIdParser(customId).data);
    }
  }
}

/**
 * Fixed text. The thrown error is deliberately not echoed here: an interaction
 * response is visible to the whole channel, and handler exceptions routinely
 * carry absolute paths, config keys, and provider responses. The rethrow keeps
 * the detail in the Gateway log where operators already look for it.
 */
const INTERACTION_FAILURE_NOTICE = "Command failed. Check the Gateway logs for details.";

type FailureReportableInteraction = {
  responseState: InteractionResponseState;
  hasSentFollowUp: boolean;
  editDeferredPlaceholderIfUnanswered(payload: {
    content: string;
    allowed_mentions: { parse: [] };
  }): Promise<boolean>;
};

/**
 * Best-effort user-visible notice for a failed interaction. Never throws: a
 * reporting failure must not mask the original error.
 *
 * Deliberately narrow. It reports only for `deferred`, where a spinner is known
 * to exist and the original response is a placeholder this dispatch created:
 *
 * - `deferred`        the deferring callback succeeded (state advances only
 *                     after a REST success), so editing the original response
 *                     resolves a spinner that would otherwise hang forever.
 * - `deferred-update` a component acknowledgement. Discord leaves no spinner,
 *                     and the original response is the message the component is
 *                     attached to, so editing it would overwrite content the
 *                     user is still reading.
 * - `unacknowledged`  nothing is known to have reached Discord. A second
 *                     initial callback risks "already acknowledged" if the
 *                     first one landed after all, and Discord already shows its
 *                     own "did not respond" notice.
 * - `replied`         the user has seen a message, and nextReplyAction() would
 *                     turn this into a contradictory follow-up beside it.
 */
async function reportInteractionFailure(interaction: FailureReportableInteraction): Promise<void> {
  if (interaction.responseState !== "deferred") {
    return;
  }
  // A follow-up has already put output in front of the user. Discord may have
  // consumed the deferred placeholder to deliver it, so editing the original
  // response here risks overwriting that output. Leaving the placeholder alone
  // is the safer failure: the user has something to see either way.
  if (interaction.hasSentFollowUp) {
    return;
  }
  try {
    // The checks above are a fast path read outside the response queue. The edit
    // re-reads both inside it, so a follow-up still in flight when the handler
    // threw settles first and this cannot overwrite output it delivered.
    //
    // allowed_mentions stays pinned even though the notice is a constant, so a
    // later change to this text cannot silently gain the ability to ping a
    // channel through Discord's default mention parsing.
    await interaction.editDeferredPlaceholderIfUnanswered({
      content: INTERACTION_FAILURE_NOTICE,
      allowed_mentions: { parse: [] },
    });
  } catch {
    // Ignored: the caller rethrows and logs the original failure.
  }
}

function resolveConditionalComponentOption(
  value: boolean | ((interaction: BaseComponentInteraction) => boolean),
  interaction: BaseComponentInteraction,
): boolean {
  return typeof value === "function" ? value(interaction) : value;
}

async function deferComponentInteractionIfNeeded(
  component: {
    defer: boolean | ((interaction: BaseComponentInteraction) => boolean);
    ephemeral: boolean | ((interaction: BaseComponentInteraction) => boolean);
  },
  interaction: BaseComponentInteraction,
): Promise<void> {
  if (!resolveConditionalComponentOption(component.defer, interaction)) {
    return;
  }
  if (resolveConditionalComponentOption(component.ephemeral, interaction)) {
    await interaction.defer({ ephemeral: true });
    return;
  }
  await interaction.acknowledge();
}

function readInteractionName(rawData: APIInteraction): string | undefined {
  return (rawData as { data?: { name?: string } }).data?.name;
}

function readCustomId(rawData: APIInteraction): string | undefined {
  return (rawData as { data?: { custom_id?: string } }).data?.custom_id;
}

function readComponentValues(rawData: APIInteraction): string[] | undefined {
  const values = (rawData as { data?: { values?: unknown } }).data?.values;
  return Array.isArray(values) ? values.map(String) : undefined;
}

function readMessageId(rawData: APIInteraction): string | undefined {
  const messageId = (rawData as { message?: { id?: unknown } }).message?.id;
  return typeof messageId === "string" ? messageId : undefined;
}

function readMessageChannelId(rawData: APIInteraction): string | undefined {
  const channelId = (rawData as { message?: { channel_id?: unknown } }).message?.channel_id;
  return typeof channelId === "string" ? channelId : undefined;
}
