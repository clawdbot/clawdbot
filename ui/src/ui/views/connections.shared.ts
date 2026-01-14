import { html, nothing } from "lit";

import type {
  DiscordStatus,
  IMessageStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types";
import type { ChannelAccountSnapshot } from "../types";
import type { ChannelKey, ConnectionsProps } from "./connections.types";

export function formatDuration(ms?: number | null) {
  if (!ms && ms !== 0) return "n/a";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

export function channelEnabled(key: ChannelKey, props: ConnectionsProps) {
  const snapshot = props.snapshot;
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!snapshot || !channels) return false;
  const whatsapp = channels.whatsapp as WhatsAppStatus | undefined;
  const telegram = channels.telegram as TelegramStatus | undefined;
  const discord = (channels.discord ?? null) as DiscordStatus | null;
  const slack = (channels.slack ?? null) as SlackStatus | null;
  const signal = (channels.signal ?? null) as SignalStatus | null;
  const imessage = (channels.imessage ?? null) as IMessageStatus | null;
  switch (key) {
    case "whatsapp":
      return (
        Boolean(whatsapp?.configured) ||
        Boolean(whatsapp?.linked) ||
        Boolean(whatsapp?.running)
      );
    case "telegram":
      return Boolean(telegram?.configured) || Boolean(telegram?.running);
    case "discord":
      return Boolean(discord?.configured || discord?.running);
    case "slack":
      return Boolean(slack?.configured || slack?.running);
    case "signal":
      return Boolean(signal?.configured || signal?.running);
    case "imessage":
      return Boolean(imessage?.configured || imessage?.running);
    default:
      return false;
  }
}

export function getChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number {
  return channelAccounts?.[key]?.length ?? 0;
}

export function renderChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
) {
  const count = getChannelAccountCount(key, channelAccounts);
  if (count < 2) return nothing;
  return html`<div class="account-count">Accounts (${count})</div>`;
}

