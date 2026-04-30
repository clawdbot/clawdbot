import {
  type APIApplicationCommandInteractionDataBasicOption,
  type APIApplicationCommandInteractionDataOption,
  type APIChannel,
  type APIInteractionDataResolvedChannel,
} from "discord-api-types/v10";
import { channelFactory, type DiscordChannel, type StructureClient } from "./structures.js";

type OptionsClient = StructureClient & {
  fetchChannel(id: string): Promise<DiscordChannel>;
};

function readFocusedOption(
  options: APIApplicationCommandInteractionDataOption[] | undefined,
): APIApplicationCommandInteractionDataBasicOption | undefined {
  for (const option of options ?? []) {
    if ("focused" in option && option.focused) {
      return option as APIApplicationCommandInteractionDataBasicOption;
    }
    const child = readFocusedOption(readChildOptions(option));
    if (child) {
      return child;
    }
  }
  return undefined;
}

function findOption(
  options: APIApplicationCommandInteractionDataOption[] | undefined,
  name: string,
): APIApplicationCommandInteractionDataOption | undefined {
  for (const option of options ?? []) {
    if (option.name === name) {
      return option;
    }
    const child = findOption(readChildOptions(option), name);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function readChildOptions(
  option: APIApplicationCommandInteractionDataOption,
): APIApplicationCommandInteractionDataOption[] | undefined {
  if (!("options" in option) || !Array.isArray(option.options)) {
    return undefined;
  }
  return option.options;
}

export class OptionsHandler {
  constructor(
    private rawOptions: APIApplicationCommandInteractionDataOption[] | undefined,
    private client: OptionsClient,
    private resolvedChannels: Record<string, APIInteractionDataResolvedChannel> | undefined,
  ) {}

  getString(name: string): string | null {
    const option = findOption(this.rawOptions, name);
    const value = option && "value" in option ? option.value : undefined;
    return typeof value === "string" ? value : null;
  }

  getNumber(name: string): number | null {
    const option = findOption(this.rawOptions, name);
    const value = option && "value" in option ? option.value : undefined;
    return typeof value === "number" ? value : null;
  }

  getBoolean(name: string): boolean | null {
    const option = findOption(this.rawOptions, name);
    const value = option && "value" in option ? option.value : undefined;
    return typeof value === "boolean" ? value : null;
  }

  async getChannel(name: string, required = false) {
    const option = findOption(this.rawOptions, name);
    const value = option && "value" in option ? option.value : undefined;
    const id = typeof value === "string" ? value : undefined;
    const resolved = id ? this.resolvedChannels?.[id] : undefined;
    if (resolved) {
      return channelFactory(this.client, resolved as APIChannel);
    }
    if (id) {
      return await this.client.fetchChannel(id);
    }
    if (required) {
      throw new Error(`Missing required channel option ${name}`);
    }
    return null;
  }

  getFocused(): APIApplicationCommandInteractionDataBasicOption | undefined {
    return readFocusedOption(this.rawOptions);
  }
}
