import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";

/** Visual tone for a portable message presentation. */
export type MessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";

/** Button style hint for renderers that support styled actions. */
export type MessagePresentationButtonStyle = InteractiveButtonStyle;

/** Portable action control rendered as a button or link by channel adapters. */
export type MessagePresentationButton = {
  /** User-visible button label. */
  label: string;
  /** Callback command or opaque value sent when the button is pressed. */
  value?: string;
  /** External URL opened by the button instead of sending a callback value. */
  url?: string;
  /** Telegram-style web app launch target. */
  webApp?: {
    url: string;
  };
  /**
   * @deprecated Use webApp. The snake_case alias is accepted for legacy JSON payloads only.
   */
  web_app?: {
    url: string;
  };
  /** Higher-priority buttons are kept first when channel limits require truncation. */
  priority?: number;
  /** Disable the button when the target channel supports disabled controls. */
  disabled?: boolean;
  /** Optional visual style hint; unsupported channels ignore or normalize it. */
  style?: InteractiveButtonStyle;
};

/** Portable select/menu option. */
export type MessagePresentationOption = {
  /** User-visible option label. */
  label: string;
  /** Callback command or opaque value sent when the option is selected. */
  value: string;
};

/**
 * @deprecated Use MessagePresentationButton.
 */
export type InteractiveReplyButton = MessagePresentationButton;

/**
 * @deprecated Use MessagePresentationOption.
 */
export type InteractiveReplyOption = MessagePresentationOption;

/**
 * @deprecated Use MessagePresentationTextBlock.
 */
export type InteractiveReplyTextBlock = {
  type: "text";
  text: string;
};

/**
 * @deprecated Use MessagePresentationButtonsBlock.
 */
type InteractiveReplyButtonsBlock = {
  type: "buttons";
  buttons: InteractiveReplyButton[];
};

/**
 * @deprecated Use MessagePresentationSelectBlock.
 */
export type InteractiveReplySelectBlock = {
  type: "select";
  placeholder?: string;
  options: InteractiveReplyOption[];
};

/**
 * @deprecated Use MessagePresentationBlock.
 */
export type InteractiveReplyBlock =
  | InteractiveReplyTextBlock
  | InteractiveReplyButtonsBlock
  | InteractiveReplySelectBlock;

/**
 * @deprecated Use MessagePresentation.
 */
export type InteractiveReply = {
  blocks: InteractiveReplyBlock[];
};

export type MessagePresentationTextBlock = {
  type: "text";
  /** Primary markdown-ish text rendered in the message body. */
  text: string;
};

export type MessagePresentationContextBlock = {
  type: "context";
  /** Lower-emphasis contextual text, or normal text on channels without context support. */
  text: string;
};

export type MessagePresentationDividerBlock = {
  type: "divider";
};

export type MessagePresentationButtonsBlock = {
  type: "buttons";
  /** Button row candidates; core may split or truncate them for channel limits. */
  buttons: MessagePresentationButton[];
};

export type MessagePresentationSelectBlock = {
  type: "select";
  /** Optional prompt shown above or inside the select control. */
  placeholder?: string;
  /** Menu options; core may truncate them for channel limits. */
  options: MessagePresentationOption[];
};

export type MessagePresentationInteractiveBlock =
  | MessagePresentationButtonsBlock
  | MessagePresentationSelectBlock;

export type MessagePresentationBlock =
  | MessagePresentationTextBlock
  | MessagePresentationContextBlock
  | MessagePresentationDividerBlock
  | MessagePresentationButtonsBlock
  | MessagePresentationSelectBlock;

export type MessagePresentation = {
  /** Optional short heading rendered before blocks when the channel supports it. */
  title?: string;
  /** Optional severity/status tone for renderers that support toned presentations. */
  tone?: MessagePresentationTone;
  /** Ordered portable blocks rendered or downgraded by the target channel adapter. */
  blocks: MessagePresentationBlock[];
};

export type ReplyPayloadDeliveryPin = {
  enabled: boolean;
  notify?: boolean;
  required?: boolean;
};

export type ReplyPayloadDelivery = {
  pin?: boolean | ReplyPayloadDeliveryPin;
};

function normalizeButtonStyle(value: unknown): InteractiveButtonStyle | undefined {
  const style = normalizeOptionalLowercaseString(value);
  return style === "primary" || style === "secondary" || style === "success" || style === "danger"
    ? style
    : undefined;
}

function normalizePresentationTone(value: unknown): MessagePresentationTone | undefined {
  const tone = normalizeOptionalLowercaseString(value);
  return tone === "info" ||
    tone === "success" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "neutral"
    ? tone
    : undefined;
}

function toRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function normalizeButton(raw: unknown): InteractiveReplyButton | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value =
    normalizeOptionalString(record.value) ??
    normalizeOptionalString(record.callbackData) ??
    normalizeOptionalString(record.callback_data);
  const url = normalizeOptionalString(record.url);
  const webAppRecord = toRecord(record.webApp) ?? toRecord(record.web_app);
  const webAppUrl = normalizeOptionalString(webAppRecord?.url);
  if (!label || (!value && !url && !webAppUrl)) {
    return undefined;
  }
  const priority =
    typeof record.priority === "number" && Number.isFinite(record.priority)
      ? record.priority
      : undefined;
  return {
    label,
    ...(value ? { value } : {}),
    ...(url ? { url } : {}),
    ...(webAppUrl ? { webApp: { url: webAppUrl } } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(record.disabled === true ? { disabled: true } : {}),
    style: normalizeButtonStyle(record.style),
  };
}

function normalizeOption(raw: unknown): InteractiveReplyOption | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value = normalizeOptionalString(record.value);
  if (!label || !value) {
    return undefined;
  }
  return { label, value };
}

function normalizeList<T>(value: unknown, normalizeEntry: (entry: unknown) => T | undefined): T[] {
  return Array.isArray(value)
    ? value.map((entry) => normalizeEntry(entry)).filter((entry): entry is T => Boolean(entry))
    : [];
}

function normalizeInteractiveBlock(raw: unknown): InteractiveReplyBlock | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "text") {
    const text = normalizeOptionalString(record.text);
    return text ? { type: "text", text } : undefined;
  }
  if (type === "buttons") {
    const buttons = normalizeList(record.buttons, normalizeButton);
    return buttons.length > 0 ? { type: "buttons", buttons } : undefined;
  }
  if (type === "select") {
    const options = normalizeList(record.options, normalizeOption);
    return options.length > 0
      ? {
          type: "select",
          placeholder: normalizeOptionalString(record.placeholder),
          options,
        }
      : undefined;
  }
  return undefined;
}

/**
 * @deprecated Use normalizeMessagePresentation.
 */
export function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const blocks = normalizeList(record.blocks, normalizeInteractiveBlock);
  return blocks.length > 0 ? { blocks } : undefined;
}

function normalizePresentationBlock(raw: unknown): MessagePresentationBlock | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "text" || type === "context") {
    const text = normalizeOptionalString(record.text);
    return text ? { type, text } : undefined;
  }
  if (type === "divider") {
    return { type: "divider" };
  }
  if (type === "buttons") {
    const buttons = normalizeList(record.buttons, normalizeButton);
    return buttons.length > 0 ? { type: "buttons", buttons } : undefined;
  }
  if (type === "select") {
    const options = normalizeList(record.options, normalizeOption);
    return options.length > 0
      ? {
          type: "select",
          placeholder: normalizeOptionalString(record.placeholder),
          options,
        }
      : undefined;
  }
  return undefined;
}

export function normalizeMessagePresentation(raw: unknown): MessagePresentation | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const blocks = normalizeList(record.blocks, normalizePresentationBlock);
  const title = normalizeOptionalString(record.title);
  if (!title && blocks.length === 0) {
    return undefined;
  }
  return {
    ...(title ? { title } : {}),
    tone: normalizePresentationTone(record.tone),
    blocks,
  };
}

/**
 * @deprecated Use hasMessagePresentationBlocks.
 */
export function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply {
  return Boolean(normalizeInteractiveReply(value));
}

export function hasMessagePresentationBlocks(value: unknown): value is MessagePresentation {
  return Boolean(normalizeMessagePresentation(value));
}

/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
export function presentationToInteractiveReply(
  presentation: MessagePresentation,
): InteractiveReply | undefined {
  const blocks: InteractiveReplyBlock[] = [];
  if (presentation.title) {
    blocks.push({ type: "text", text: presentation.title });
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "buttons") {
      const buttons = block.buttons
        .filter((button) => button.value || button.url || button.webApp || button.web_app)
        .map((button) => {
          const interactiveButton: InteractiveReplyButton = {
            label: button.label,
            style: button.style,
          };
          if (button.value) {
            interactiveButton.value = button.value;
          }
          if (button.url) {
            interactiveButton.url = button.url;
          }
          const webApp = button.webApp ?? button.web_app;
          if (webApp) {
            interactiveButton.webApp = webApp;
          }
          if (button.priority !== undefined) {
            interactiveButton.priority = button.priority;
          }
          if (button.disabled === true) {
            interactiveButton.disabled = true;
          }
          return interactiveButton;
        });
      if (buttons.length > 0) {
        blocks.push({ type: "buttons", buttons });
      }
      continue;
    }
    if (block.type === "select") {
      blocks.push({
        type: "select",
        placeholder: block.placeholder,
        options: block.options,
      });
    }
  }
  return blocks.length > 0 ? { blocks } : undefined;
}

export function isMessagePresentationInteractiveBlock(
  block: MessagePresentationBlock,
): block is MessagePresentationInteractiveBlock {
  return block.type === "buttons" || block.type === "select";
}

/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
export function presentationToInteractiveControlsReply(
  presentation: MessagePresentation,
): InteractiveReply | undefined {
  return presentationToInteractiveReply({
    blocks: presentation.blocks.filter(isMessagePresentationInteractiveBlock),
  });
}

/**
 * @deprecated Legacy bridge for old InteractiveReply payloads. New producers should send MessagePresentation.
 */
export function interactiveReplyToPresentation(
  interactive: InteractiveReply,
): MessagePresentation | undefined {
  const blocks = interactive.blocks.map((block): MessagePresentationBlock => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "buttons") {
      return { type: "buttons", buttons: block.buttons };
    }
    return {
      type: "select",
      placeholder: block.placeholder,
      options: block.options,
    };
  });
  return blocks.length > 0 ? { blocks } : undefined;
}

export function renderMessagePresentationFallbackText(params: {
  presentation?: MessagePresentation;
  emptyFallback?: string | null;
  text?: string | null;
}): string {
  const lines: string[] = [];
  const text = normalizeOptionalString(params.text);
  if (text) {
    lines.push(text);
  }
  const presentation = params.presentation;
  if (!presentation) {
    return lines.join("\n\n");
  }
  if (presentation.title) {
    lines.push(presentation.title);
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      lines.push(block.text);
      continue;
    }
    if (block.type === "buttons") {
      const labels = block.buttons
        .map((button) => {
          const targetUrl = button.url ?? button.webApp?.url ?? button.web_app?.url;
          return targetUrl ? `${button.label}: ${targetUrl}` : button.label;
        })
        .filter(Boolean);
      if (labels.length > 0) {
        lines.push(labels.map((label) => `- ${label}`).join("\n"));
      }
      continue;
    }
    if (block.type === "select") {
      const labels = block.options.map((option) => option.label).filter(Boolean);
      if (labels.length > 0) {
        const heading = block.placeholder ? `${block.placeholder}:` : "Options:";
        lines.push(`${heading}\n${labels.map((label) => `- ${label}`).join("\n")}`);
      }
    }
  }
  const rendered = lines.join("\n\n");
  return rendered || normalizeOptionalString(params.emptyFallback) || "";
}

export function hasReplyChannelData(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0,
  );
}

export function hasReplyContent(params: {
  text?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: ReadonlyArray<string | null | undefined>;
  interactive?: unknown;
  presentation?: unknown;
  hasChannelData?: boolean;
  extraContent?: boolean;
}): boolean {
  const text = normalizeOptionalString(params.text);
  const mediaUrl = normalizeOptionalString(params.mediaUrl);
  return Boolean(
    text ||
    mediaUrl ||
    params.mediaUrls?.some((entry) => Boolean(normalizeOptionalString(entry))) ||
    hasMessagePresentationBlocks(params.presentation) ||
    hasInteractiveReplyBlocks(params.interactive) ||
    params.hasChannelData ||
    params.extraContent,
  );
}

export function hasReplyPayloadContent(
  payload: {
    text?: string | null;
    mediaUrl?: string | null;
    mediaUrls?: ReadonlyArray<string | null | undefined>;
    interactive?: unknown;
    presentation?: unknown;
    channelData?: unknown;
  },
  options?: {
    trimText?: boolean;
    hasChannelData?: boolean;
    extraContent?: boolean;
  },
): boolean {
  return hasReplyContent({
    text: options?.trimText ? payload.text?.trim() : payload.text,
    mediaUrl: payload.mediaUrl,
    mediaUrls: payload.mediaUrls,
    interactive: payload.interactive,
    presentation: payload.presentation,
    hasChannelData: options?.hasChannelData ?? hasReplyChannelData(payload.channelData),
    extraContent: options?.extraContent,
  });
}

/**
 * @deprecated Use renderMessagePresentationFallbackText with MessagePresentation.
 */
export function resolveInteractiveTextFallback(params: {
  text?: string;
  interactive?: InteractiveReply;
}): string | undefined {
  const text = normalizeOptionalString(params.text);
  if (text) {
    return params.text;
  }
  const interactiveText = (params.interactive?.blocks ?? [])
    .filter((block): block is InteractiveReplyTextBlock => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return interactiveText || params.text;
}
