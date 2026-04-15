import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig, SlackSlashCommandConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SlackFile, SlackMessageEvent } from "../types.js";

export type MonitorSlackOpts = {
  botToken?: string;
  appToken?: string;
  accountId?: string;
  mode?: "socket" | "http";
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  slashCommand?: SlackSlashCommandConfig;
  /** Callback to update the channel account status snapshot (e.g. lastEventAt). */
  setStatus?: (next: Record<string, unknown>) => void;
  /** Callback to read the current channel account status snapshot. */
  getStatus?: () => Record<string, unknown>;
};

export type SlackReactionEvent = {
  type: "reaction_added" | "reaction_removed";
  user?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  item_user?: string;
  event_ts?: string;
};

export type SlackMemberChannelEvent = {
  type: "member_joined_channel" | "member_left_channel";
  user?: string;
  channel?: string;
  channel_type?: SlackMessageEvent["channel_type"];
  event_ts?: string;
};

export type SlackChannelCreatedEvent = {
  type: "channel_created";
  channel?: { id?: string; name?: string };
  event_ts?: string;
};

export type SlackChannelRenamedEvent = {
  type: "channel_rename";
  channel?: { id?: string; name?: string; name_normalized?: string };
  event_ts?: string;
};

export type SlackChannelIdChangedEvent = {
  type: "channel_id_changed";
  old_channel_id?: string;
  new_channel_id?: string;
  event_ts?: string;
};

export type SlackPinEvent = {
  type: "pin_added" | "pin_removed";
  channel_id?: string;
  user?: string;
  item?: { type?: string; message?: { ts?: string } };
  event_ts?: string;
};

export type SlackMessageChangedEvent = {
  type: "message";
  subtype: "message_changed";
  channel?: string;
  message?: { ts?: string; user?: string; bot_id?: string };
  previous_message?: { ts?: string; user?: string; bot_id?: string };
  event_ts?: string;
};

export type SlackMessageDeletedEvent = {
  type: "message";
  subtype: "message_deleted";
  channel?: string;
  deleted_ts?: string;
  previous_message?: { ts?: string; user?: string; bot_id?: string };
  event_ts?: string;
};

export type SlackThreadBroadcastEvent = {
  type: "message";
  subtype: "thread_broadcast";
  channel?: string;
  user?: string;
  message?: { ts?: string; user?: string; bot_id?: string };
  event_ts?: string;
};

export type { SlackFile, SlackMessageEvent };
