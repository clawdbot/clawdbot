import type { OpenClawConfig } from "../config/types.js";
import type { CommandArgValues } from "./commands-args.types.js";

export type { CommandArgValue, CommandArgValues, CommandArgs } from "./commands-args.types.js";

export type CommandScope = "text" | "native" | "both";

/**
 * Controls progressive disclosure of commands in the UI.
 * - "essential": Always visible (~10 core commands)
 * - "standard": Shown on expand / "Show more" (~15 commands)
 * - "power": Only surfaced via search or explicit filter (~15 commands)
 */
export type CommandTier = "essential" | "standard" | "power";

export type CommandCategory =
  | "session"
  | "options"
  | "status"
  | "management"
  | "media"
  | "tools"
  | "docks";

export type CommandArgType = "string" | "number" | "boolean";

export type CommandArgChoiceContext = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
};

export type CommandArgChoice = string | { value: string; label: string };

export type CommandArgChoicesProvider = (context: CommandArgChoiceContext) => CommandArgChoice[];

export type CommandArgDefinition = {
  name: string;
  description: string;
  type: CommandArgType;
  required?: boolean;
  choices?: CommandArgChoice[] | CommandArgChoicesProvider;
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
};

export type CommandArgMenuSpec = {
  arg: string;
  title?: string;
};

export type CommandArgsParsing = "none" | "positional";

export type ChatCommandDefinition = {
  key: string;
  nativeName?: string;
  description: string;
  textAliases: string[];
  acceptsArgs?: boolean;
  args?: CommandArgDefinition[];
  argsParsing?: CommandArgsParsing;
  formatArgs?: (values: CommandArgValues) => string | undefined;
  argsMenu?: CommandArgMenuSpec | "auto";
  scope: CommandScope;
  category?: CommandCategory;
  /** Progressive disclosure tier. Defaults to "standard" when omitted. */
  tier?: CommandTier;
};

export type NativeCommandSpec = {
  name: string;
  description: string;
  acceptsArgs: boolean;
  args?: CommandArgDefinition[];
};

export type CommandNormalizeOptions = {
  botUsername?: string;
};

export type CommandDetection = {
  exact: Set<string>;
  regex: RegExp;
};

export type ShouldHandleTextCommandsParams = {
  cfg: OpenClawConfig;
  surface: string;
  commandSource?: "text" | "native";
};
