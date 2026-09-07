// Line plugin module implements template messages behavior.
import type { messagingApi } from "@line/bot-sdk";
import {
  messageAction,
  normalizeLineAction,
  postbackAction,
  uriAction,
  type Action,
} from "./actions.js";
import type { LineTemplateMessagePayload } from "./types.js";

type TemplateMessage = messagingApi.TemplateMessage;
type ConfirmTemplate = messagingApi.ConfirmTemplate;
type ButtonsTemplate = messagingApi.ButtonsTemplate;
type CarouselTemplate = messagingApi.CarouselTemplate;
type CarouselColumn = messagingApi.CarouselColumn;

const COMPACT_TEMPLATE_TEXT_LIMIT = 60;
const TEMPLATE_ALT_TEXT_LIMIT = 1500;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type TemplatePayloadAction = {
  type?: "uri" | "postback" | "message";
  uri?: string;
  data?: string;
  label: string;
};

function buildTemplatePayloadAction(action: TemplatePayloadAction): Action {
  if (action.type === "uri" && action.uri) {
    return uriAction(action.label, action.uri);
  }
  if (action.type === "postback" && action.data) {
    return postbackAction(action.label, action.data, action.label);
  }
  return messageAction(action.label, action.data ?? action.label);
}

function resolveTemplateTextLimit(params: {
  title?: string;
  thumbnailImageUrl?: string;
  textOnlyLimit: number;
}): number {
  return params.title !== undefined || params.thumbnailImageUrl !== undefined
    ? COMPACT_TEMPLATE_TEXT_LIMIT
    : params.textOnlyLimit;
}

function truncateTemplateText(text: string, limit: number): string {
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (result.length + segment.length > limit) {
      // A pathological grapheme can exceed LINE's whole field limit. Preserve
      // graphemes normally, but keep required text non-empty without splitting
      // a surrogate pair when the first grapheme alone cannot fit.
      if (!result) {
        for (const codePoint of segment) {
          if (result.length + codePoint.length > limit) {
            break;
          }
          result += codePoint;
        }
      }
      break;
    }
    result += segment;
  }
  return result;
}

function truncateOptionalTemplateText(
  value: string | undefined,
  limit: number,
): string | undefined {
  return value === undefined ? undefined : truncateTemplateText(value, limit);
}

function resolveTemplateAltText(value: string | undefined, fallback: string): string {
  return truncateTemplateText(value ?? fallback, TEMPLATE_ALT_TEXT_LIMIT);
}

function normalizeCarouselColumnActions(column: CarouselColumn): CarouselColumn {
  return {
    ...column,
    actions: column.actions.map((action) => normalizeLineAction(action)),
    defaultAction:
      column.defaultAction === undefined ? undefined : normalizeLineAction(column.defaultAction),
  };
}

/**
 * Create a confirm template (yes/no style dialog)
 */
export function createConfirmTemplate(
  text: string,
  confirmAction: Action,
  cancelAction: Action,
  altText?: string,
): TemplateMessage {
  const template: ConfirmTemplate = {
    type: "confirm",
    text: truncateTemplateText(text, 240), // LINE limit
    actions: [normalizeLineAction(confirmAction), normalizeLineAction(cancelAction)],
  };

  return {
    type: "template",
    altText: resolveTemplateAltText(altText, text),
    template,
  };
}

/**
 * Create a button template with title, text, and action buttons
 */
export function createButtonTemplate(
  title: string | undefined,
  text: string,
  actions: Action[],
  options?: {
    thumbnailImageUrl?: string;
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    imageBackgroundColor?: string;
    defaultAction?: Action;
    altText?: string;
  },
): TemplateMessage {
  const normalizedTitle = title || undefined;
  const textLimit = resolveTemplateTextLimit({
    title: normalizedTitle,
    thumbnailImageUrl: options?.thumbnailImageUrl,
    textOnlyLimit: 160,
  });
  const template: ButtonsTemplate = {
    type: "buttons",
    ...(normalizedTitle ? { title: truncateTemplateText(normalizedTitle, 40) } : {}), // LINE limit
    text: truncateTemplateText(text, textLimit),
    actions: actions.slice(0, 4).map((action) => normalizeLineAction(action)), // LINE limit: max 4 actions
    thumbnailImageUrl: options?.thumbnailImageUrl,
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
    imageBackgroundColor: options?.imageBackgroundColor,
    defaultAction:
      options?.defaultAction === undefined ? undefined : normalizeLineAction(options.defaultAction),
  };

  return {
    type: "template",
    altText: resolveTemplateAltText(
      options?.altText,
      normalizedTitle ? `${normalizedTitle}: ${text}` : text,
    ),
    template,
  };
}

/**
 * Create a carousel template with multiple columns
 */
export function createTemplateCarousel(
  columns: CarouselColumn[],
  options?: {
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    altText?: string;
  },
): TemplateMessage {
  const template: CarouselTemplate = {
    type: "carousel",
    columns: columns.slice(0, 10).map(normalizeCarouselColumnActions), // LINE limit: max 10 columns
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
  };

  return {
    type: "template",
    altText: resolveTemplateAltText(options?.altText, "View carousel"),
    template,
  };
}

/**
 * Create a carousel column for use with createTemplateCarousel
 */
export function createCarouselColumn(params: {
  title?: string;
  text: string;
  actions: Action[];
  thumbnailImageUrl?: string;
  imageBackgroundColor?: string;
  defaultAction?: Action;
}): CarouselColumn {
  // LINE caps a carousel column's text at 60 chars when the column carries a
  // title or thumbnail image, and 120 chars otherwise. Sending an over-length
  // text makes LINE reject the whole carousel, so mirror the conditional limit
  // the buttons template already applies above.
  const textLimit = resolveTemplateTextLimit({ ...params, textOnlyLimit: 120 });
  return {
    title: truncateOptionalTemplateText(params.title, 40),
    text: truncateTemplateText(params.text, textLimit),
    actions: params.actions.slice(0, 3).map((action) => normalizeLineAction(action)), // LINE limit: max 3 actions per column
    thumbnailImageUrl: params.thumbnailImageUrl,
    imageBackgroundColor: params.imageBackgroundColor,
    defaultAction:
      params.defaultAction === undefined ? undefined : normalizeLineAction(params.defaultAction),
  };
}

/**
 * Convert a TemplateMessagePayload from ReplyPayload to a LINE TemplateMessage
 */
export function buildTemplateMessageFromPayload(
  payload: LineTemplateMessagePayload,
): TemplateMessage | null {
  switch (payload.type) {
    case "confirm": {
      const confirmAction = payload.confirmData.startsWith("http")
        ? uriAction(payload.confirmLabel, payload.confirmData)
        : payload.confirmData.includes("=")
          ? postbackAction(payload.confirmLabel, payload.confirmData, payload.confirmLabel)
          : messageAction(payload.confirmLabel, payload.confirmData);

      const cancelAction = payload.cancelData.startsWith("http")
        ? uriAction(payload.cancelLabel, payload.cancelData)
        : payload.cancelData.includes("=")
          ? postbackAction(payload.cancelLabel, payload.cancelData, payload.cancelLabel)
          : messageAction(payload.cancelLabel, payload.cancelData);

      return createConfirmTemplate(payload.text, confirmAction, cancelAction, payload.altText);
    }

    case "buttons": {
      const actions: Action[] = payload.actions
        .slice(0, 4)
        .map((action) => buildTemplatePayloadAction(action));

      return createButtonTemplate(payload.title, payload.text, actions, {
        thumbnailImageUrl: payload.thumbnailImageUrl,
        altText: payload.altText,
      });
    }

    case "carousel": {
      const columns: CarouselColumn[] = payload.columns.slice(0, 10).map((col) => {
        const colActions: Action[] = col.actions
          .slice(0, 3)
          .map((action) => buildTemplatePayloadAction(action));

        return createCarouselColumn({
          title: col.title,
          text: col.text,
          thumbnailImageUrl: col.thumbnailImageUrl,
          actions: colActions,
        });
      });

      return createTemplateCarousel(columns, { altText: payload.altText });
    }

    default:
      return null;
  }
}

export type { TemplateMessage, ConfirmTemplate, ButtonsTemplate, CarouselTemplate, CarouselColumn };
