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
