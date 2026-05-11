import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveCommandArgChoices,
  type ChatCommandDefinition,
} from "openclaw/plugin-sdk/native-command-registry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AutocompleteInteraction, CommandOptions } from "../internal/discord.js";

const log = createSubsystemLogger("discord/native-command");

// Discord application command and option descriptions are limited to 1-100 chars.
// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-structure
const DISCORD_COMMAND_DESCRIPTION_MAX = 100;

export function truncateDiscordCommandDescription(params: {
  value: string;
  label: string;
}): string {
  const { value, label } = params;
  if (value.length <= DISCORD_COMMAND_DESCRIPTION_MAX) {
    return value;
  }
  log.warn(
    `discord: truncating native command description (${label}) from ${value.length} to ${DISCORD_COMMAND_DESCRIPTION_MAX}: ${JSON.stringify(value)}`,
  );
  return value.slice(0, DISCORD_COMMAND_DESCRIPTION_MAX);
}

export function truncateDiscordCommandDescriptionLocalizations(params: {
  value?: Record<string, string>;
  label: string;
}): Record<string, string> | undefined {
  const entries = Object.entries(params.value ?? {});
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    entries.map(([locale, description]) => [
      locale,
      truncateDiscordCommandDescription({
        value: description,
        label: `${params.label} locale:${locale}`,
      }),
    ]),
  );
}

function resolveDiscordCommandLogLabel(command: ChatCommandDefinition): string {
  if (typeof command.nativeName === "string" && command.nativeName.trim().length > 0) {
    return command.nativeName;
  }
  return command.key;
}

export function buildDiscordCommandOptions(params: {
  command: ChatCommandDefinition;
  cfg: OpenClawConfig;
  authorizeChoiceContext?: (interaction: AutocompleteInteraction) => Promise<boolean>;
  resolveChoiceContext?: (
    interaction: AutocompleteInteraction,
  ) => Promise<{ provider?: string; model?: string } | null>;
}): CommandOptions | undefined {
  const { command, cfg, authorizeChoiceContext, resolveChoiceContext } = params;
  const commandLabel = resolveDiscordCommandLogLabel(command);
  const args = command.args;
  if (!args || args.length === 0) {
    return undefined;
  }
  return args.map((arg) => {
    const required = arg.required ?? false;
    if (arg.type === "number") {
      return {
        name: arg.name,
        description: truncateDiscordCommandDescription({
          value: arg.description,
          label: `command:${commandLabel} arg:${arg.name}`,
        }),
        type: ApplicationCommandOptionType.Number,
        required,
      };
    }
    if (arg.type === "boolean") {
      return {
        name: arg.name,
        description: truncateDiscordCommandDescription({
          value: arg.description,
          label: `command:${commandLabel} arg:${arg.name}`,
        }),
        type: ApplicationCommandOptionType.Boolean,
        required,
      };
    }
    const resolvedChoices = resolveCommandArgChoices({ command, arg, cfg });
    const shouldAutocomplete =
      arg.preferAutocomplete === true ||
      (resolvedChoices.length > 0 &&
        (typeof arg.choices === "function" || resolvedChoices.length > 25));
    const autocomplete = shouldAutocomplete
      ? async (interaction: AutocompleteInteraction) => {
          if (
            typeof arg.choices === "function" &&
            resolveChoiceContext &&
            authorizeChoiceContext &&
            !(await authorizeChoiceContext(interaction))
          ) {
            await interaction.respond([]);
            return;
          }
          const focused = interaction.options.getFocused();
          const focusValue = normalizeLowercaseStringOrEmpty(focused?.value);
          const context =
            typeof arg.choices === "function" && resolveChoiceContext
              ? await resolveChoiceContext(interaction)
              : null;
          const choices = resolveCommandArgChoices({
            command,
            arg,
            cfg,
            provider: context?.provider,
            model: context?.model,
          });
          const filtered = focusValue
            ? choices.filter((choice) =>
                normalizeLowercaseStringOrEmpty(choice.label).includes(focusValue),
              )
            : choices;
          await interaction.respond(
            filtered.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.value })),
          );
        }
      : undefined;
    const choices =
      resolvedChoices.length > 0 && !autocomplete
        ? resolvedChoices.slice(0, 25).map((choice) => ({
            name: choice.label,
            value: choice.value,
          }))
        : undefined;
    return {
      name: arg.name,
      description: truncateDiscordCommandDescription({
        value: arg.description,
        label: `command:${commandLabel} arg:${arg.name}`,
      }),
      type: ApplicationCommandOptionType.String,
      required,
      choices,
      autocomplete,
    };
  }) satisfies CommandOptions;
}
