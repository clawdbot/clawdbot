import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";

export type InteractiveReplyButton = {
  label: string;
  value?: string;
  url?: string;
  style?: InteractiveButtonStyle;
};

export type InteractiveReplyOption = {
  label: string;
  value: string;
};

export type InteractiveReplyTextBlock = {
  type: "text";
  text: string;
};

export type InteractiveReplyButtonsBlock = {
  type: "buttons";
  buttons: InteractiveReplyButton[];
};

export type InteractiveReplySelectBlock = {
  type: "select";
  placeholder?: string;
  options: InteractiveReplyOption[];
};

export type InteractiveReplyBlock =
  | InteractiveReplyTextBlock
  | InteractiveReplyButtonsBlock
  | InteractiveReplySelectBlock;

export type InteractiveReply = {
  blocks: InteractiveReplyBlock[];
};

export type MessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";

export type MessagePresentationButtonStyle = InteractiveButtonStyle;

export type MessagePresentationButton = {
  label: string;
  value?: string;
  url?: string;
  style?: MessagePresentationButtonStyle;
};

export type MessagePresentationOption = {
  label: string;
  value: string;
};

export type MessagePresentationTextBlock = {
  type: "text";
  text: string;
};

export type MessagePresentationContextBlock = {
  type: "context";
  text: string;
};

export type MessagePresentationDividerBlock = {
  type: "divider";
};

export type MessagePresentationButtonsBlock = {
  type: "buttons";
  buttons: MessagePresentationButton[];
};

export type MessagePresentationSelectBlock = {
  type: "select";
  placeholder?: string;
  options: MessagePresentationOption[];
};

export type MessagePresentationBlock =
  | MessagePresentationTextBlock
  | MessagePresentationContextBlock
  | MessagePresentationDividerBlock
  | MessagePresentationButtonsBlock
  | MessagePresentationSelectBlock;

export type MessagePresentation = {
  title?: string;
  tone?: MessagePresentationTone;
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

function normalizeInteractiveButton(raw: unknown): InteractiveReplyButton | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value =
    normalizeOptionalString(record.value) ??
    normalizeOptionalString(record.callbackData) ??
    normalizeOptionalString(record.callback_data);
  const url = normalizeOptionalString(record.url);
  if (!label || (!value && !url)) {
    return undefined;
  }
  return {
    label,
    ...(value ? { value } : {}),
    ...(url ? { url } : {}),
    style: normalizeButtonStyle(record.style),
  };
}

function normalizeInteractiveOption(raw: unknown): InteractiveReplyOption | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value = normalizeOptionalString(record.value);
  if (!label || !value) {
    return undefined;
  }
  return { label, value };
}

function normalizeInteractiveBlock(raw: unknown): InteractiveReplyBlock | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "text") {
    const text = normalizeOptionalString(record.text);
    return text ? { type: "text", text } : undefined;
  }
  if (type === "buttons") {
    const buttons = Array.isArray(record.buttons)
      ? record.buttons
          .map((entry) => normalizeInteractiveButton(entry))
          .filter((entry): entry is InteractiveReplyButton => Boolean(entry))
      : [];
    return buttons.length > 0 ? { type: "buttons", buttons } : undefined;
  }
  if (type === "select") {
    const options = Array.isArray(record.options)
      ? record.options
          .map((entry) => normalizeInteractiveOption(entry))
          .filter((entry): entry is InteractiveReplyOption => Boolean(entry))
      : [];
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

export function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks
        .map((entry) => normalizeInteractiveBlock(entry))
        .filter((entry): entry is InteractiveReplyBlock => Boolean(entry))
    : [];
  return blocks.length > 0 ? { blocks } : undefined;
}

function normalizePresentationButton(raw: unknown): MessagePresentationButton | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value =
    normalizeOptionalString(record.value) ??
    normalizeOptionalString(record.callbackData) ??
    normalizeOptionalString(record.callback_data);
  const url = normalizeOptionalString(record.url);
  if (!label || (!value && !url)) {
    return undefined;
  }
  return {
    label,
    ...(value ? { value } : {}),
    ...(url ? { url } : {}),
    style: normalizeButtonStyle(record.style),
  };
}

function normalizePresentationOption(raw: unknown): MessagePresentationOption | undefined {
  const option = normalizeInteractiveOption(raw);
  return option ? { label: option.label, value: option.value } : undefined;
}

function normalizePresentationBlock(raw: unknown): MessagePresentationBlock | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "text" || type === "context") {
    const text = normalizeOptionalString(record.text);
    return text ? { type, text } : undefined;
  }
  if (type === "divider") {
    return { type: "divider" };
  }
  if (type === "buttons") {
    const buttons = Array.isArray(record.buttons)
      ? record.buttons
          .map((entry) => normalizePresentationButton(entry))
          .filter((entry): entry is MessagePresentationButton => Boolean(entry))
      : [];
    return buttons.length > 0 ? { type: "buttons", buttons } : undefined;
  }
  if (type === "select") {
    const options = Array.isArray(record.options)
      ? record.options
          .map((entry) => normalizePresentationOption(entry))
          .filter((entry): entry is MessagePresentationOption => Boolean(entry))
      : [];
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks
        .map((entry) => normalizePresentationBlock(entry))
        .filter((entry): entry is MessagePresentationBlock => Boolean(entry))
    : [];
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

export function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply {
  return Boolean(normalizeInteractiveReply(value));
}

export function hasMessagePresentationBlocks(value: unknown): value is MessagePresentation {
  return Boolean(normalizeMessagePresentation(value));
}

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
        .filter((button) => button.value || button.url)
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
        .map((button) => (button.url ? `${button.label}: ${button.url}` : button.label))
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
  return lines.join("\n\n");
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
