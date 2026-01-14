import type { ClawdbotConfig } from "../config/types.js";

export type CommandScope = "text" | "native" | "both";

export type ChatCommandDefinition = {
  key: string;
  nativeName?: string;
  description: string;
  textAliases: string[];
  acceptsArgs?: boolean;
  scope: CommandScope;
};

export type NativeCommandSpec = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

export type CommandNormalizeOptions = {
  botUsername?: string;
};

export type CommandDetection = {
  exact: Set<string>;
  regex: RegExp;
};

export type ShouldHandleTextCommandsParams = {
  cfg: ClawdbotConfig;
  surface: string;
  commandSource?: "text" | "native";
};
