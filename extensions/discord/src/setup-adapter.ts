import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Discord plugin module implements setup adapter behavior.
import {
  createEnvPatchedAccountSetupAdapter,
  type ChannelSetupAdapter,
} from "openclaw/plugin-sdk/setup-runtime";

const channel = "discord" as const;

// A Discord application ID is a bare numeric snowflake. A bot token always
// carries dot-separated segments, so a purely numeric token can never
// authenticate: it means the application ID was pasted into the token field.
const DISCORD_SNOWFLAKE_PATTERN = /^\d{15,25}$/;

function isNumericApplicationId(value: unknown): boolean {
  return typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value.trim());
}

const discordSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  channelKey: channel,
  defaultAccountOnlyEnvError: "DISCORD_BOT_TOKEN can only be used for the default account.",
  missingCredentialError: "Discord requires token (or --use-env).",
  hasCredentials: (input) => Boolean(input.token),
  validateInput: ({ input }) =>
    isNumericApplicationId(input.token)
      ? "Discord token looks like a numeric application ID, not a bot token. Paste the bot token from the Discord Developer Portal (Bot page), not the application ID (General Information page)."
      : null,
  buildPatch: (input) => (input.token ? { token: input.token } : {}),
});

export const discordSetupContract = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "Discord bot token" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use DISCORD_BOT_TOKEN" },
      envVars: ["DISCORD_BOT_TOKEN"],
    },
  },
  legacyAdapter: discordSetupAdapter,
});
