import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { CommandArgValues } from "openclaw/plugin-sdk/native-command-registry";

export type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

export type DiscordCommandArgs = {
  raw?: string;
  values?: CommandArgValues;
};
