import { InteractionType, type APIInteraction } from "discord-api-types/v10";
import {
  type BaseCommand,
  deferCommandInteractionIfNeeded,
  resolveFocusedCommandOptionAutocompleteHandler,
} from "./commands.js";
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
  commands: BaseCommand[];
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
    if ("autocomplete" in command) {
      await (
        command as { autocomplete: (interaction: AutocompleteInteraction) => Promise<void> }
      ).autocomplete(autocompleteInteraction);
    }
    return;
  }
  if (rawData.type === InteractionType.ApplicationCommand) {
    const command = client.commands.find((entry) => entry.name === readInteractionName(rawData));
    if (command && "run" in command) {
      await deferCommandInteractionIfNeeded(command, interaction as CommandInteraction);
      await (command as { run: (interaction: CommandInteraction) => Promise<void> }).run(
        interaction as CommandInteraction,
      );
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
