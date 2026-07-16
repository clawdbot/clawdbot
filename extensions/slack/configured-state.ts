const SLACK_CONFIGURED_ENV_KEYS = ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"];

export function hasSlackConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return SLACK_CONFIGURED_ENV_KEYS.some(
    (key) => typeof params.env?.[key] === "string" && params.env[key]?.trim().length > 0,
  );
}
