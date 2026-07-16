export function hasTelegramConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.TELEGRAM_BOT_TOKEN === "string" &&
    params.env.TELEGRAM_BOT_TOKEN.trim().length > 0
  );
}
