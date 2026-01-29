export type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

export type SlackMessageEvent = {
  type: "message";
  user?: string;
  bot_id?: string;
  subtype?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  files?: SlackFile[];
  blocks?: unknown[];
  attachments?: unknown[];
};

export type SlackAppMentionEvent = {
  type: "app_mention";
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
};
