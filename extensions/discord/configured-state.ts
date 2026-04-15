export function hasDiscordConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.DISCORD_BOT_TOKEN === "string" &&
    params.env.DISCORD_BOT_TOKEN.trim().length > 0
  );
}
