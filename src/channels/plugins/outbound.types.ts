import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver-types.js";
import type { OutboundDeliveryFormattingOptions } from "../../infra/outbound/formatting.js";
import type { OutboundIdentity } from "../../infra/outbound/identity-types.js";
import type { OutboundSendDeps } from "../../infra/outbound/send-deps.js";
import type { MessagePresentation, ReplyPayloadDeliveryPin } from "../../interactive/payload.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type {
  ChannelOutboundTargetMode,
  ChannelPollContext,
  ChannelPollResult,
} from "./types.core.js";

export type ChannelOutboundContext = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl?: string;
  audioAsVoice?: boolean;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gifPlayback?: boolean;
  /** Send image, GIF, or video as document to avoid channel compression. */
  forceDocument?: boolean;
  replyToId?: string | null;
  replyToIdSource?: "explicit" | "implicit";
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
};

export type ChannelOutboundPayloadContext = ChannelOutboundContext & {
  payload: ReplyPayload;
};

export type ChannelPresentationCapabilities = {
  /** Whether the channel accepts structured presentation payloads at all. */
  supported?: boolean;
  /** Whether the channel can render button action blocks natively. */
  buttons?: boolean;
  /** Whether the channel can render select/menu blocks natively. */
  selects?: boolean;
  /** Whether the channel can render low-emphasis context blocks natively. */
  context?: boolean;
  /** Whether the channel can render divider blocks natively. */
  divider?: boolean;
  /** Per-channel limits used to adapt portable presentation blocks before rendering. */
  limits?: {
    actions?: {
      /** Maximum total button/select actions in one message. */
      maxActions?: number;
      /** Maximum buttons per rendered action row. */
      maxActionsPerRow?: number;
      /** Maximum action rows in one message. */
      maxRows?: number;
      /** Maximum user-visible button label length. */
      maxLabelLength?: number;
      /** Maximum callback/action value size in UTF-8 bytes. */
      maxValueBytes?: number;
      /** Whether action styles such as primary or danger are preserved. */
      supportsStyles?: boolean;
      /** Whether disabled button state is preserved. */
      supportsDisabled?: boolean;
      /** Whether priority/layout hints affect native rendering. */
      supportsLayoutHints?: boolean;
    };
    selects?: {
      /** Maximum options in one select/menu block. */
      maxOptions?: number;
      /** Maximum user-visible option label length. */
      maxLabelLength?: number;
      /** Maximum option callback value size in UTF-8 bytes. */
      maxValueBytes?: number;
    };
    text?: {
      /** Maximum text length for title, text, and context blocks. */
      maxLength?: number;
      /** Unit used by maxLength. Defaults to Unicode code points. */
      encoding?: "characters" | "utf8-bytes" | "utf16-units";
      /** Markdown dialect understood by rendered text blocks. */
      markdownDialect?: "plain" | "markdown" | "html" | "slack-mrkdwn" | "discord-markdown";
      /** Whether the channel can edit presentation text in-place. */
      supportsEdit?: boolean;
    };
  };
};

export type ChannelDeliveryCapabilities = {
  pin?: boolean;
  durableFinal?: {
    text?: boolean;
    media?: boolean;
    payload?: boolean;
    silent?: boolean;
    replyTo?: boolean;
    thread?: boolean;
    nativeQuote?: boolean;
    messageSendingHooks?: boolean;
    batch?: boolean;
    reconcileUnknownSend?: boolean;
    afterSendSuccess?: boolean;
    afterCommit?: boolean;
  };
};

export type ChannelOutboundPayloadHint =
  | {
      kind: "approval-pending";
      approvalKind: "exec" | "plugin";
      nativeRouteActive?: boolean;
    }
  | { kind: "approval-resolved"; approvalKind: "exec" | "plugin" };

export type ChannelOutboundTargetRef = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

export type ChannelOutboundFormattedContext = ChannelOutboundContext & {
  abortSignal?: AbortSignal;
};

export type ChannelOutboundChunkContext = {
  formatting?: OutboundDeliveryFormattingOptions;
};

export type ChannelOutboundNormalizePayloadParams = {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  accountId?: string | null;
};

export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  chunker?: ((text: string, limit: number, ctx?: ChannelOutboundChunkContext) => string[]) | null;
  chunkerMode?: "text" | "markdown";
  chunkedTextFormatting?: OutboundDeliveryFormattingOptions;
  /** Lift remote Markdown image syntax in text into outbound media attachments. */
  extractMarkdownImages?: boolean;
  textChunkLimit?: number;
  sanitizeText?: (params: { text: string; payload: ReplyPayload }) => string;
  pollMaxOptions?: number;
  supportsPollDurationSeconds?: boolean;
  supportsAnonymousPolls?: boolean;
  normalizePayload?: (params: ChannelOutboundNormalizePayloadParams) => ReplyPayload | null;
  sendTextOnlyErrorPayloads?: boolean;
  shouldSkipPlainTextSanitization?: (params: { payload: ReplyPayload }) => boolean;
  resolveEffectiveTextChunkLimit?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    fallbackLimit?: number;
  }) => number | undefined;
  shouldSuppressLocalPayloadPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    payload: ReplyPayload;
    hint?: ChannelOutboundPayloadHint;
  }) => boolean;
  beforeDeliverPayload?: (params: {
    cfg: OpenClawConfig;
    target: ChannelOutboundTargetRef;
    payload: ReplyPayload;
    hint?: ChannelOutboundPayloadHint;
  }) => Promise<void> | void;
  afterDeliverPayload?: (params: {
    cfg: OpenClawConfig;
    target: ChannelOutboundTargetRef;
    payload: ReplyPayload;
    results: readonly OutboundDeliveryResult[];
  }) => Promise<void> | void;
  /** Channel-advertised presentation features and limits used by core adaptation. */
  presentationCapabilities?: ChannelPresentationCapabilities;
  deliveryCapabilities?: ChannelDeliveryCapabilities;
  /** Render an adapted portable presentation into channel-native payload data. */
  renderPresentation?: (params: {
    payload: ReplyPayload;
    presentation: MessagePresentation;
    ctx: ChannelOutboundPayloadContext;
  }) => Promise<ReplyPayload | null> | ReplyPayload | null;
  pinDeliveredMessage?: (params: {
    cfg: OpenClawConfig;
    target: ChannelOutboundTargetRef;
    messageId: string;
    pin: ReplyPayloadDeliveryPin;
  }) => Promise<void> | void;
  /**
   * @deprecated Use shouldTreatDeliveredTextAsVisible instead.
   */
  shouldTreatRoutedTextAsVisible?: (params: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => boolean;
  shouldTreatDeliveredTextAsVisible?: (params: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => boolean;
  preferFinalAssistantVisibleText?: boolean;
  targetsMatchForReplySuppression?: (params: {
    originTarget: string;
    targetKey: string;
    targetThreadId?: string;
  }) => boolean;
  resolveTarget?: (params: {
    cfg?: OpenClawConfig;
    to?: string;
    allowFrom?: string[];
    accountId?: string | null;
    mode?: ChannelOutboundTargetMode;
  }) => { ok: true; to: string } | { ok: false; error: Error };
  sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
  sendFormattedText?: (ctx: ChannelOutboundFormattedContext) => Promise<OutboundDeliveryResult[]>;
  sendFormattedMedia?: (
    ctx: ChannelOutboundFormattedContext & { mediaUrl: string },
  ) => Promise<OutboundDeliveryResult>;
  sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ChannelPollContext) => Promise<ChannelPollResult>;
};
