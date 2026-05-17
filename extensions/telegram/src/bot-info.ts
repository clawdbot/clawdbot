export type TelegramBotInfo = {
  id: number;
  is_bot: true;
  first_name: string;
  last_name?: string;
  username: string;
  language_code?: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  can_manage_bots: boolean;
  supports_inline_queries: boolean;
  can_connect_to_business: boolean;
  has_main_web_app: boolean;
  has_topics_enabled: boolean;
  allows_users_to_create_topics: boolean;
};

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function normalizeTelegramBotInfo(value: unknown): TelegramBotInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const bot = value as Record<string, unknown>;
  if (
    typeof bot.id !== "number" ||
    bot.is_bot !== true ||
    typeof bot.first_name !== "string" ||
    typeof bot.username !== "string"
  ) {
    return undefined;
  }
  return {
    id: bot.id,
    is_bot: true,
    first_name: bot.first_name,
    username: bot.username,
    ...(typeof bot.last_name === "string" ? { last_name: bot.last_name } : {}),
    ...(typeof bot.language_code === "string" ? { language_code: bot.language_code } : {}),
    can_join_groups: normalizeBoolean(bot.can_join_groups) ?? false,
    can_read_all_group_messages: normalizeBoolean(bot.can_read_all_group_messages) ?? false,
    can_manage_bots: normalizeBoolean(bot.can_manage_bots) ?? false,
    supports_inline_queries: normalizeBoolean(bot.supports_inline_queries) ?? false,
    can_connect_to_business: normalizeBoolean(bot.can_connect_to_business) ?? false,
    has_main_web_app: normalizeBoolean(bot.has_main_web_app) ?? false,
    has_topics_enabled: normalizeBoolean(bot.has_topics_enabled) ?? false,
    allows_users_to_create_topics: normalizeBoolean(bot.allows_users_to_create_topics) ?? false,
  };
}
