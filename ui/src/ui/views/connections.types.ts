import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  DiscordStatus,
  IMessageStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types";
import type {
  DiscordForm,
  IMessageForm,
  SignalForm,
  SlackForm,
  TelegramForm,
} from "../ui-types";

export type ChannelKey =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "imessage";

export type ConnectionsProps = {
  connected: boolean;
  loading: boolean;
  snapshot: ChannelsStatusSnapshot | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  whatsappMessage: string | null;
  whatsappQrDataUrl: string | null;
  whatsappConnected: boolean | null;
  whatsappBusy: boolean;
  telegramForm: TelegramForm;
  telegramTokenLocked: boolean;
  telegramSaving: boolean;
  telegramStatus: string | null;
  discordForm: DiscordForm;
  discordTokenLocked: boolean;
  discordSaving: boolean;
  discordStatus: string | null;
  slackForm: SlackForm;
  slackTokenLocked: boolean;
  slackAppTokenLocked: boolean;
  slackSaving: boolean;
  slackStatus: string | null;
  signalForm: SignalForm;
  signalSaving: boolean;
  signalStatus: string | null;
  imessageForm: IMessageForm;
  imessageSaving: boolean;
  imessageStatus: string | null;
  onRefresh: (probe: boolean) => void;
  onWhatsAppStart: (force: boolean) => void;
  onWhatsAppWait: () => void;
  onWhatsAppLogout: () => void;
  onTelegramChange: (patch: Partial<TelegramForm>) => void;
  onTelegramSave: () => void;
  onDiscordChange: (patch: Partial<DiscordForm>) => void;
  onDiscordSave: () => void;
  onSlackChange: (patch: Partial<SlackForm>) => void;
  onSlackSave: () => void;
  onSignalChange: (patch: Partial<SignalForm>) => void;
  onSignalSave: () => void;
  onIMessageChange: (patch: Partial<IMessageForm>) => void;
  onIMessageSave: () => void;
};

export type ConnectionsChannelData = {
  whatsapp?: WhatsAppStatus;
  telegram?: TelegramStatus;
  discord?: DiscordStatus | null;
  slack?: SlackStatus | null;
  signal?: SignalStatus | null;
  imessage?: IMessageStatus | null;
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null;
};

