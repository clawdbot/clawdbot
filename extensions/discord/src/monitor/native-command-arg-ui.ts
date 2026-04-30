import { ButtonStyle } from "discord-api-types/v10";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  listChatCommands,
  serializeCommandArgs,
  type ChatCommandDefinition,
  type CommandArgDefinition,
  type CommandArgValues,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth";
import { chunkItems } from "openclaw/plugin-sdk/text-runtime";
import {
  Button,
  Row,
  type ButtonInteraction,
  type CommandInteraction,
  type ComponentData,
} from "../internal/discord.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type {
  DiscordCommandArgContext,
  SafeDiscordInteractionCall,
} from "./native-command-ui.types.js";

const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";

function createCommandArgsWithValue(params: { argName: string; value: string }): CommandArgs {
  const values: CommandArgValues = { [params.argName]: params.value };
  return { values };
}

function encodeDiscordCommandArgValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeDiscordCommandArgValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildDiscordCommandArgCustomId(params: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}): string {
  return [
    `${DISCORD_COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeDiscordCommandArgValue(params.command)}`,
    `arg=${encodeDiscordCommandArgValue(params.arg)}`,
    `value=${encodeDiscordCommandArgValue(params.value)}`,
    `user=${encodeDiscordCommandArgValue(params.userId)}`,
  ].join(";");
}

function parseDiscordCommandArgData(
  data: ComponentData,
): { command: string; arg: string; value: string; userId: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawCommand = coerce(data.command);
  const rawArg = coerce(data.arg);
  const rawValue = coerce(data.value);
  const rawUser = coerce(data.user);
  if (!rawCommand || !rawArg || !rawValue || !rawUser) {
    return null;
  }
  return {
    command: decodeDiscordCommandArgValue(rawCommand),
    arg: decodeDiscordCommandArgValue(rawArg),
    value: decodeDiscordCommandArgValue(rawValue),
    userId: decodeDiscordCommandArgValue(rawUser),
  };
}

export async function handleDiscordCommandArgInteraction(params: {
  interaction: ButtonInteraction;
  data: ComponentData;
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}) {
  const { interaction, data, ctx } = params;
  const clearWithMessage = async (content: string) =>
    await params.safeInteractionCall("command arg update", () =>
      interaction.update({ content, components: [] }),
    );
  const parsed = parseDiscordCommandArgData(data);
  if (!parsed) {
    await clearWithMessage("Sorry, that selection is no longer available.");
    return;
  }
  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await params.safeInteractionCall("command arg ack", () => interaction.acknowledge());
    return;
  }
  const commandDefinition =
    findCommandByNativeName(parsed.command, "discord") ??
    listChatCommands().find((entry) => entry.key === parsed.command);
  if (!commandDefinition) {
    await clearWithMessage("Sorry, that command is no longer available.");
    return;
  }
  const argUpdateResult = await clearWithMessage(`✅ Selected ${parsed.value}.`);
  if (argUpdateResult === null) {
    return;
  }
  const commandArgs = createCommandArgsWithValue({
    argName: parsed.arg,
    value: parsed.value,
  });
  const commandArgsWithRaw: CommandArgs = {
    ...commandArgs,
    raw: serializeCommandArgs(commandDefinition, commandArgs),
  };
  const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
  await params.dispatchCommandInteraction({
    interaction,
    prompt,
    command: commandDefinition,
    commandArgs: commandArgsWithRaw,
    cfg: ctx.cfg,
    discordConfig: ctx.discordConfig,
    accountId: ctx.accountId,
    sessionPrefix: ctx.sessionPrefix,
    preferFollowUp: true,
    threadBindings: ctx.threadBindings,
    responseEphemeral: resolveDiscordSlashCommandConfig(ctx.discordConfig?.slashCommand).ephemeral,
  });
}

type DiscordCommandArgButtonParams = {
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
};

async function runDiscordCommandArgButton(
  params: DiscordCommandArgButtonParams & {
    interaction: ButtonInteraction;
    data: ComponentData;
  },
) {
  await handleDiscordCommandArgInteraction(params);
}

class DiscordCommandArgButton extends Button {
  label: string;
  customId: string;
  style = ButtonStyle.Secondary;

  constructor(
    params: {
      label: string;
      customId: string;
    } & DiscordCommandArgButtonParams,
  ) {
    super();
    this.label = params.label;
    this.customId = params.customId;
    this.params = params;
  }

  private params: DiscordCommandArgButtonParams;

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await runDiscordCommandArgButton({ ...this.params, interaction, data });
  }
}

export function buildDiscordCommandArgMenu(params: {
  command: ChatCommandDefinition;
  menu: {
    arg: CommandArgDefinition;
    choices: Array<{ value: string; label: string }>;
    title?: string;
  };
  interaction: CommandInteraction;
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}): { content: string; components: Row<Button>[] } {
  const { command, menu, interaction } = params;
  const commandLabel = command.nativeName ?? command.key;
  const userId = interaction.user?.id ?? "";
  const rows = chunkItems(menu.choices, 4).map((choices) => {
    const buttons = choices.map(
      (choice) =>
        new DiscordCommandArgButton({
          label: choice.label,
          customId: buildDiscordCommandArgCustomId({
            command: commandLabel,
            arg: menu.arg.name,
            value: choice.value,
            userId,
          }),
          ctx: params.ctx,
          safeInteractionCall: params.safeInteractionCall,
          dispatchCommandInteraction: params.dispatchCommandInteraction,
        }),
    );
    return new Row(buttons);
  });
  const content = formatCommandArgMenuTitle({ command, menu });
  return { content, components: rows };
}

class DiscordCommandArgFallbackButton extends Button {
  label = "cmdarg";
  customId = "cmdarg:seed=1";

  constructor(private readonly params: DiscordCommandArgButtonParams) {
    super();
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await runDiscordCommandArgButton({ ...this.params, interaction, data });
  }
}

export function createDiscordCommandArgFallbackButton(
  params: DiscordCommandArgButtonParams,
): Button {
  return new DiscordCommandArgFallbackButton(params);
}
