import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Discord plugin module implements setup adapter behavior.
import {
  createEnvPatchedAccountSetupAdapter,
  type ChannelSetupAdapter,
} from "openclaw/plugin-sdk/setup-runtime";

const channel = "discord" as const;

const discordSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  channelKey: channel,
  defaultAccountOnlyEnvError: "DISCORD_BOT_TOKEN can only be used for the default account.",
  missingCredentialError: "Discord requires token (or --use-env).",
  hasCredentials: (input) => Boolean(input.token),
  validateInput: ({ input }) =>
    input.token && /^\d+$/.test(input.token.trim())
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
