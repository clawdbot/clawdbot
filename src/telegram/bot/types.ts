import type { Message } from "@grammyjs/types";

export type TelegramQuote = {
  text?: string;
};

export type TelegramMessage = Message & {
  quote?: TelegramQuote;
};

export type TelegramStreamMode = "off" | "partial" | "block";

export type TelegramForwardOriginType = "user" | "hidden_user" | "chat" | "channel";

export type TelegramForwardUser = {
  first_name?: string;
  last_name?: string;
  username?: string;
  id?: number;
};

export type TelegramForwardChat = {
  title?: string;
  id?: number;
  username?: string;
  type?: string;
};

export type TelegramForwardOrigin = {
  type: TelegramForwardOriginType;
  sender_user?: TelegramForwardUser;
  sender_user_name?: string;
  sender_chat?: TelegramForwardChat;
  chat?: TelegramForwardChat;
  date?: number;
};

export type TelegramForwardMetadata = {
  forward_origin?: TelegramForwardOrigin;
  forward_from?: TelegramForwardUser;
  forward_from_chat?: TelegramForwardChat;
  forward_sender_name?: string;
  forward_signature?: string;
  forward_date?: number;
};

export type TelegramForwardedMessage = TelegramMessage & TelegramForwardMetadata;

export type TelegramContext = {
  message: TelegramMessage;
  me?: { id?: number; username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

/** Telegram Location object */
export interface TelegramLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  live_period?: number;
  heading?: number;
}

/** Telegram Venue object */
export interface TelegramVenue {
  location: TelegramLocation;
  title: string;
  address: string;
  foursquare_id?: string;
  foursquare_type?: string;
  google_place_id?: string;
  google_place_type?: string;
}

/** Telegram sticker metadata for context enrichment. */
export interface StickerMetadata {
  /** Emoji associated with the sticker. */
  emoji?: string;
  /** Name of the sticker set the sticker belongs to. */
  setName?: string;
  /** Telegram file_id for sending the sticker back. */
  fileId?: string;
  /** Stable file_unique_id for cache deduplication. */
  fileUniqueId?: string;
  /** Cached description from previous vision processing (skip re-processing if present). */
  cachedDescription?: string;
}
