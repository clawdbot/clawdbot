/** Type contracts for text/native chat command definitions and command detection. */
import type { OpenClawConfig } from "../config/types.js";
import type { CommandArgValues } from "./commands-args.types.js";
import type { ThinkingCatalogEntry } from "./thinking.shared.js";

export type { CommandArgValues, CommandArgs } from "./commands-args.types.js";

/** Where a command may be invoked. */
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

/** Primitive command argument kinds supported by native command surfaces. */
type CommandArgType = "string" | "number" | "boolean";

/** Context passed to dynamic command argument choice providers. */
export type CommandArgChoiceContext = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  catalog?: ThinkingCatalogEntry[];
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
};

export type CommandArgChoice = string | { value: string; label: string };

type CommandArgChoicesProvider = (context: CommandArgChoiceContext) => CommandArgChoice[];

/** One positional argument accepted by a chat command. */
export type CommandArgDefinition = {
  name: string;
  description: string;
  type: CommandArgType;
  required?: boolean;
  choices?: CommandArgChoice[] | CommandArgChoicesProvider;
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
};

/** Menu metadata for commands that should prompt for a missing argument. */
export type CommandArgMenuSpec = {
  arg: string;
  title?: string;
};

export type CommandArgsParsing = "none" | "positional";

/** Canonical registry entry for one chat command across text and native surfaces. */
export type ChatCommandDefinition = {
  key: string;
  nativeName?: string;
  nativeAliases?: string[];
  nativeProviders?: string[];
  description: string;
  /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>;
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

/** Provider-facing native command registration shape. */
export type NativeCommandSpec = {
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
  args?: CommandArgDefinition[];
  isAlias?: boolean;
};

/** Extra context used when normalizing slash command text. */
export type CommandNormalizeOptions = {
  botUsername?: string;
};

/** Cached exact/regex command detector built from current registry aliases. */
export type CommandDetection = {
  exact: Set<string>;
  regex: RegExp;
};

/** Inputs for deciding whether text slash commands should run on a surface. */
export type ShouldHandleTextCommandsParams = {
  cfg: OpenClawConfig;
  surface: string;
  commandSource?: "text" | "native";
};
