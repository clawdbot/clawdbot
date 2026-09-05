import type { messagingApi } from "@line/bot-sdk";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  LINE_FLEX_BUBBLE_MAX_BYTES,
  LINE_FLEX_CAROUSEL_MAX_BYTES,
} from "./flex-templates/message.js";
import { isHttpsUrl } from "./media-url.js";

export type Action = messagingApi.Action;
type Message = messagingApi.Message;
type ImagemapAction = messagingApi.ImagemapAction;
type ImagemapVideo = messagingApi.ImagemapVideo;
const LINE_ACTION_LABEL_LIMIT = 20;
const LINE_ACTION_DATA_LIMIT = 300;
const LINE_ACTION_URI_LIMIT = 1000;
const LINE_CLIPBOARD_TEXT_LIMIT = 1000;
const LINE_RICH_MENU_ALIAS_LIMIT = 32;
const LINE_IMAGEMAP_ACTION_LABEL_LIMIT = 100;
const LINE_IMAGEMAP_MESSAGE_TEXT_LIMIT = 400;
const LINE_IMAGEMAP_EXTERNAL_LINK_LABEL_LIMIT = 30;
const LINE_IMAGEMAP_ACTION_LIMIT = 50;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncateLineActionText(text: string, limit: number): string {
  let result = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const codePointCount = Array.from(segment).length;
    if (count + codePointCount > limit) {
      break;
    }
    result += segment;
    count += codePointCount;
  }
  return result;
}

export function truncateLineActionLabel(label: string, limit = LINE_ACTION_LABEL_LIMIT): string {
  const truncated = truncateLineActionText(label, limit);
  return truncated || (label ? "…" : "");
}

function truncateLineActionData(data: string): string {
  return truncateUtf16Safe(data, LINE_ACTION_DATA_LIMIT);
}

const UNDELIVERABLE_IMAGE_WARNING = "Image unavailable: URL must use HTTPS.";

function flexWarning(text: string): messagingApi.FlexText {
  return { type: "text", text, wrap: true, size: "sm", color: "#B45309", margin: "md" };
}

const unavailableActionMarker = Symbol("lineUnavailableAction");
type UnavailableAction = Extract<Action, { type: "message" }> & {
  [unavailableActionMarker]: true;
};

function unavailableAction(kind: "Action" | "Link", reason: string): Action {
  const action = {
    type: "message",
    label: "Unavailable",
    text: `${kind} unavailable: ${reason}`,
  } satisfies Action;
  Object.defineProperty(action, unavailableActionMarker, { value: true });
  return action;
}

const actionTypes = new Set([
  "camera",
  "cameraRoll",
  "clipboard",
  "datetimepicker",
  "location",
  "message",
  "postback",
  "richmenuswitch",
  "uri",
]);

function isLineAction(value: unknown): value is Action {
  return isRecord(value) && typeof value.type === "string" && actionTypes.has(value.type);
}

function isUnavailableAction(action: Action): action is UnavailableAction {
  return (action as Partial<UnavailableAction>)[unavailableActionMarker] === true;
}

function normalizeNestedContent(value: unknown, labelLimit: number, warnings?: string[]): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeNestedContent(item, labelLimit, warnings))
      .filter((item) => item !== undefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (warnings && (value.type === "image" || value.type === "icon") && !isHttpsUrl(value.url)) {
    warnings.push(UNDELIVERABLE_IMAGE_WARNING);
    return undefined;
  }

  const normalized: Record<string, unknown> = { ...value };
  for (const [key, nested] of Object.entries(value)) {
    if ((key === "action" || key === "defaultAction") && isLineAction(nested)) {
      const action = normalizeLineAction(nested, labelLimit);
      if (
        warnings &&
        key === "action" &&
        ((value.type === "video" && action.type !== "uri") ||
          (value.type !== "button" && isUnavailableAction(action)))
      ) {
        delete normalized[key];
        warnings.push(
          isUnavailableAction(action)
            ? (action.text ?? "Action unavailable.")
            : "Action unavailable in this video.",
        );
      } else {
        normalized[key] = action;
      }
    } else if (key === "actions" && Array.isArray(nested)) {
      normalized[key] = nested.map((action) =>
        isLineAction(action) ? normalizeLineAction(action, labelLimit) : action,
      );
    } else {
      const content = normalizeNestedContent(nested, labelLimit, warnings);
      if (content === undefined) {
        delete normalized[key];
      } else {
        normalized[key] = content;
      }
    }
  }
  if (warnings && value.type === "video") {
    // LINE requires a Box or Image alternative even when the video itself is valid.
    const altContent = normalized.altContent ?? {
      type: "box",
      layout: "vertical",
      contents: [flexWarning(UNDELIVERABLE_IMAGE_WARNING)],
    };
    if (!isHttpsUrl(value.url) || !isHttpsUrl(value.previewUrl)) {
      warnings.push("Video unavailable: video and preview URLs must use HTTPS.");
      return altContent;
    }
    normalized.altContent = altContent;
  }
  return normalized;
}

function normalizeFlexBubble(value: unknown, maxBytes = LINE_FLEX_BUBBLE_MAX_BYTES): unknown {
  if (!isRecord(value) || value.type !== "bubble") {
    return normalizeNestedContent(value, 40);
  }

  const warnings: string[] = [];
  const normalized = normalizeNestedContent(value, 40, warnings);
  if (!isRecord(normalized) || warnings.length === 0) {
    return normalized;
  }

  const warning = flexWarning([...new Set(warnings)].join("\n"));
  const body = normalized.body;
  const withWarning = {
    ...normalized,
    body:
      isRecord(body) && Array.isArray(body.contents)
        ? { ...body, contents: [...body.contents, warning] }
        : { type: "box", layout: "vertical", contents: [warning] },
  };
  // Removing a short invalid URL can save fewer bytes than its optional warning.
  // Keep the user's content deliverable within both bubble and carousel limits.
  return Buffer.byteLength(JSON.stringify(withWarning), "utf8") <=
    Math.min(maxBytes, LINE_FLEX_BUBBLE_MAX_BYTES)
    ? withWarning
    : normalized;
}

function normalizeFlexContainer(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (value.type === "bubble") {
    return normalizeFlexBubble(value);
  }
  if (value.type === "carousel" && Array.isArray(value.contents)) {
    let remainingBytes =
      LINE_FLEX_CAROUSEL_MAX_BYTES - Buffer.byteLength(JSON.stringify(value), "utf8");
    return {
      ...value,
      contents: value.contents.map((bubble) => {
        const originalBytes = Buffer.byteLength(JSON.stringify(bubble), "utf8");
        const normalized = normalizeFlexBubble(bubble, originalBytes + remainingBytes);
        remainingBytes += originalBytes - Buffer.byteLength(JSON.stringify(normalized), "utf8");
        return normalized;
      }),
    };
  }
  return normalizeNestedContent(value, 40);
}

function unavailableImagemapAction(
  kind: "Action" | "Link",
  reason: string,
  area: ImagemapAction["area"],
): ImagemapAction {
  return {
    type: "message",
    label: "Unavailable",
    text: `${kind} unavailable: ${reason}`,
    area,
  };
}

function normalizeImagemapAction(action: ImagemapAction): ImagemapAction {
  const label =
    action.label === undefined
      ? undefined
      : truncateLineActionText(action.label, LINE_IMAGEMAP_ACTION_LABEL_LIMIT);

  if (action.type === "uri") {
    if (truncateUtf16Safe(action.linkUri, LINE_ACTION_URI_LIMIT) !== action.linkUri) {
      return unavailableImagemapAction("Link", "URL exceeds LINE's limit.", action.area);
    }
    return { ...action, label };
  }

  if (action.type === "message") {
    const text = truncateUtf16Safe(action.text, LINE_IMAGEMAP_MESSAGE_TEXT_LIMIT);
    if (text !== action.text) {
      return unavailableImagemapAction("Action", "message text exceeds LINE's limit.", action.area);
    }
    return { ...action, label, text };
  }

  if (truncateUtf16Safe(action.clipboardText, LINE_CLIPBOARD_TEXT_LIMIT) !== action.clipboardText) {
    return unavailableImagemapAction("Action", "clipboard text exceeds LINE's limit.", action.area);
  }
  return { ...action, label };
}

function normalizeImagemapVideo(video: ImagemapVideo): {
  video: ImagemapVideo;
  fallbackAction?: ImagemapAction;
} {
  const externalLink = video.externalLink;
  if (!externalLink) {
    return { video };
  }

  const label =
    externalLink.label === undefined
      ? undefined
      : truncateUtf16Safe(externalLink.label, LINE_IMAGEMAP_EXTERNAL_LINK_LABEL_LIMIT) ||
        (externalLink.label ? "…" : "");
  if (
    externalLink.linkUri !== undefined &&
    truncateUtf16Safe(externalLink.linkUri, LINE_ACTION_URI_LIMIT) !== externalLink.linkUri
  ) {
    const normalizedVideo = { ...video };
    delete normalizedVideo.externalLink;
    return {
      video: normalizedVideo,
      fallbackAction:
        video.area === undefined
          ? undefined
          : unavailableImagemapAction("Link", "URL exceeds LINE's limit.", video.area),
    };
  }
  return { video: { ...video, externalLink: { ...externalLink, label } } };
}

export function normalizeLineMessage(message: Message): Message {
  let normalized: Message;
  if (message.type === "flex") {
    normalized = {
      ...message,
      contents: normalizeFlexContainer(message.contents) as messagingApi.FlexContainer,
    };
  } else if (message.type === "template") {
    const labelLimit = message.template.type === "image_carousel" ? 12 : 20;
    const template = normalizeNestedContent(message.template, labelLimit) as messagingApi.Template;
    const columns =
      template.type === "carousel"
        ? template.columns
        : template.type === "buttons"
          ? [template]
          : [];
    // Template carousel columns must agree on image presence; a partial strip is invalid.
    if (columns.some((column) => !isHttpsUrl(column.thumbnailImageUrl))) {
      for (const column of columns) {
        delete column.thumbnailImageUrl;
      }
    }
    normalized = { ...message, template };
  } else if (message.type === "imagemap") {
    const actions = message.actions.map(normalizeImagemapAction);
    const videoResult = message.video ? normalizeImagemapVideo(message.video) : undefined;
    if (videoResult?.fallbackAction) {
      // At LINE's 50-action cap, silently drop the invalid video link so its
      // warning never displaces a valid action.
      if (actions.length < LINE_IMAGEMAP_ACTION_LIMIT) {
        actions.push(videoResult.fallbackAction);
      }
    }
    normalized = {
      ...message,
      actions,
      video: videoResult?.video,
    };
  } else {
    normalized = { ...message };
  }

  if (message.quickReply) {
    normalized = {
      ...normalized,
      quickReply: normalizeNestedContent(message.quickReply, 20) as messagingApi.QuickReply,
    };
  }

  return normalized;
}

export function normalizeLineAction(action: Action, labelLimit = LINE_ACTION_LABEL_LIMIT): Action {
  if (isUnavailableAction(action)) {
    return action;
  }
  const label =
    action.label === undefined ? undefined : truncateLineActionLabel(action.label, labelLimit);

  if (action.type === "uri") {
    const uriTooLong =
      action.uri !== undefined &&
      truncateUtf16Safe(action.uri, LINE_ACTION_URI_LIMIT) !== action.uri;
    const desktopUri = action.altUri?.desktop;
    const desktopUriTooLong =
      desktopUri !== undefined &&
      truncateUtf16Safe(desktopUri, LINE_ACTION_URI_LIMIT) !== desktopUri;
    if (uriTooLong || desktopUriTooLong) {
      return unavailableAction("Link", "URL exceeds LINE's limit.");
    }
    return { ...action, label };
  }

  if (action.type === "postback") {
    const data = action.data === undefined ? undefined : truncateLineActionData(action.data);
    if (data !== action.data) {
      // Callback data is opaque and echoed back by LINE. Never dispatch a value
      // whose identity changed merely to satisfy the transport cap.
      return unavailableAction("Action", "callback data exceeds LINE's limit.");
    }
    const text =
      action.text === undefined
        ? undefined
        : truncateLineActionText(action.text, LINE_ACTION_DATA_LIMIT);
    const fillInText =
      action.fillInText === undefined
        ? undefined
        : truncateLineActionText(action.fillInText, LINE_ACTION_DATA_LIMIT);
    if (text !== action.text || fillInText !== action.fillInText) {
      return unavailableAction("Action", "message text exceeds LINE's limit.");
    }
    return {
      ...action,
      label,
      data,
      displayText:
        action.displayText === undefined
          ? undefined
          : truncateLineActionText(action.displayText, LINE_ACTION_DATA_LIMIT),
      text,
      fillInText,
    };
  }

  if (action.type === "datetimepicker") {
    const data = action.data === undefined ? undefined : truncateLineActionData(action.data);
    if (data !== action.data) {
      return unavailableAction("Action", "callback data exceeds LINE's limit.");
    }
    return { ...action, label, data };
  }

  if (action.type === "message") {
    const text =
      action.text === undefined
        ? undefined
        : truncateLineActionText(action.text, LINE_ACTION_DATA_LIMIT);
    if (text !== action.text) {
      return unavailableAction("Action", "message text exceeds LINE's limit.");
    }
    return {
      ...action,
      label,
      text,
    };
  }

  if (action.type === "clipboard") {
    if (
      truncateUtf16Safe(action.clipboardText, LINE_CLIPBOARD_TEXT_LIMIT) !== action.clipboardText
    ) {
      return unavailableAction("Action", "clipboard text exceeds LINE's limit.");
    }
    return { ...action, label };
  }

  if (action.type === "richmenuswitch") {
    const data = action.data === undefined ? undefined : truncateLineActionData(action.data);
    const aliasTooLong =
      action.richMenuAliasId !== undefined &&
      truncateUtf16Safe(action.richMenuAliasId, LINE_RICH_MENU_ALIAS_LIMIT) !==
        action.richMenuAliasId;
    if (data !== action.data || aliasTooLong) {
      return unavailableAction("Action", "rich menu data exceeds LINE's limit.");
    }
    return { ...action, label, data };
  }

  return action.label === label ? action : { ...action, label };
}

/**
 * Create a message action (sends text when tapped)
 */
export function messageAction(label: string, text?: string): Action {
  return normalizeLineAction({
    type: "message",
    label,
    text: text ?? label,
  });
}

/**
 * Create a URI action (opens a URL when tapped)
 */
export function uriAction(label: string, uri: string): Action {
  return normalizeLineAction({
    type: "uri",
    label,
    uri,
  });
}

/**
 * Create a postback action (sends data to webhook when tapped)
 */
export function postbackAction(label: string, data: string, displayText?: string): Action {
  return normalizeLineAction({
    type: "postback",
    label,
    data,
    displayText,
  });
}

/**
 * Create a datetime picker action
 */
export function datetimePickerAction(
  label: string,
  data: string,
  mode: "date" | "time" | "datetime",
  options?: {
    initial?: string;
    max?: string;
    min?: string;
  },
): Action {
  return normalizeLineAction({
    type: "datetimepicker",
    label,
    data,
    mode,
    initial: options?.initial,
    max: options?.max,
    min: options?.min,
  });
}
