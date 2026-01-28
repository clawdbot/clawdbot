import type { MoltbotConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

export type IMessageAttachment = {
  original_path?: string | null;
  mime_type?: string | null;
  missing?: boolean | null;
};

export type IMessagePayload = {
  id?: number | null;
  chat_id?: number | null;
  sender?: string | null;
  is_from_me?: boolean | null;
  text?: string | null;
  reply_to_id?: number | string | null;
  reply_to_text?: string | null;
  reply_to_sender?: string | null;
  created_at?: string | null;
  attachments?: IMessageAttachment[] | null;
  chat_identifier?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
};

export type MonitorIMessageOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  cliPath?: string;
  dbPath?: string;
  accountId?: string;
  config?: MoltbotConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  includeAttachments?: boolean;
  mediaMaxMb?: number;
  requireMention?: boolean;
};
