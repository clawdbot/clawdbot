export type SlackFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  subtype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

export type SlackAttachment = {
  fallback?: string;
  text?: string;
  pretext?: string;
  author_name?: string;
  author_id?: string;
  from_url?: string;
  ts?: string;
  channel_name?: string;
  channel_id?: string;
  is_msg_unfurl?: boolean;
  is_share?: boolean;
  image_url?: string;
  image_width?: number;
  image_height?: number;
  thumb_url?: string;
  files?: SlackFile[];
  message_blocks?: unknown[];
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
  attachments?: SlackAttachment[];
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
  attachments?: SlackAttachment[];
};
