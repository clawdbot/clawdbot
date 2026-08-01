// Line plugin module implements actions behavior.
import type { messagingApi } from "@line/bot-sdk";
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { hasNonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export type Action = messagingApi.Action;
type Message = messagingApi.Message;
type ImagemapAction = messagingApi.ImagemapAction;
type ImagemapVideo = messagingApi.ImagemapVideo;
const LINE_ACTION_LABEL_LIMIT = 20;
const LINE_ACTION_DATA_LIMIT = 300;
const LINE_ACTION_URI_LIMIT = 1000;
const LINE_CLIPBOARD_TEXT_LIMIT = 1000;
const LINE_RICH_MENU_ALIAS_LIMIT = 32;
const LINE_QUICK_REPLY_ITEM_LIMIT = 13;
const LINE_QUICK_REPLY_IMAGE_URL_LIMIT = 2000;
const LINE_IMAGEMAP_ACTION_LABEL_LIMIT = 100;
const LINE_IMAGEMAP_MESSAGE_TEXT_LIMIT = 400;
const LINE_IMAGEMAP_EXTERNAL_LINK_LABEL_LIMIT = 30;
const LINE_IMAGEMAP_ACTION_LIMIT = 50;
const lineActionUriProtocols = new Set(["http:", "https:", "line:", "tel:"]);
const linePostbackInputOptions = new Set([
  "closeRichMenu",
  "openRichMenu",
  "openKeyboard",
  "openVoice",
]);
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isValidLineUri(value: unknown, icon = false): value is string {
  const limit = icon ? LINE_QUICK_REPLY_IMAGE_URL_LIMIT : LINE_ACTION_URI_LIMIT;
  if (typeof value !== "string" || value.length > limit) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return icon ? protocol === "https:" : lineActionUriProtocols.has(protocol);
  } catch {
    return false;
  }
}

function invalidLineUriReason(value: unknown): string {
  return typeof value === "string" && value.length > LINE_ACTION_URI_LIMIT
    ? "URL exceeds LINE's limit."
    : "URL scheme is not supported by LINE.";
}

function isValidLineDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1900 || year > 2100) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isValidLinePickerValue(value: unknown, mode: string): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const isTime = (time: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (mode === "date") {
    return isValidLineDate(value);
  }
  if (mode === "time") {
    return isTime(value);
  }
  const [date, time, ...extra] = value.split(/[Tt]/);
  return (
    extra.length === 0 &&
    date !== undefined &&
    time !== undefined &&
    isValidLineDate(date) &&
    isTime(time)
  );
}

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

function isValidQuickReplyAction(value: unknown): value is Action {
  if (!isLineAction(value) || !hasNonEmptyString(value.label)) {
    return false;
  }
  switch (value.type) {
    case "message":
      return typeof value.text === "string";
    case "uri":
      return hasNonEmptyString(value.uri);
    case "postback":
      // Callback data explicitly allows an empty string; only a missing value is invalid.
      return typeof value.data === "string";
    case "datetimepicker":
      return (
        typeof value.data === "string" &&
        (value.mode === "date" || value.mode === "time" || value.mode === "datetime")
      );
    default:
      return true;
  }
}

function isUnavailableAction(action: Action): action is UnavailableAction {
  return (action as Partial<UnavailableAction>)[unavailableActionMarker] === true;
}

type LineMessageActionSurface = "flex" | "template" | "image-carousel" | "quick-reply";

function normalizeMessageSurfaceAction(
  action: Action,
  labelLimit: number,
  surface: LineMessageActionSurface,
  requireLabel = false,
): Action {
  if (surface === "quick-reply" && !isValidQuickReplyAction(action)) {
    // Existing malformed buttons remain filterable instead of consuming visible reply slots.
    return action;
  }
  if (requireLabel && !hasNonEmptyString(action.label)) {
    return unavailableAction("Action", "action label is missing.");
  }
  // Rich-menu switching is valid only on menu areas, never on message-owned actions.
  if (action.type === "richmenuswitch") {
    return unavailableAction("Action", "rich menu switching is only available in rich menus.");
  }
  // Camera, camera-roll, and location controls are exclusive to quick-reply buttons.
  if (
    surface !== "quick-reply" &&
    (action.type === "camera" || action.type === "cameraRoll" || action.type === "location")
  ) {
    return unavailableAction("Action", "this action is only available in quick replies.");
  }
  if (surface === "quick-reply" && action.type === "postback" && action.text !== undefined) {
    // Quick replies reject deprecated text; displayText preserves its visible wording.
    const { text, ...postback } = action;
    return normalizeLineAction(
      { ...postback, displayText: postback.displayText ?? text },
      labelLimit,
    );
  }
  return normalizeLineAction(action, labelLimit);
}

function normalizeNestedActions(
  value: unknown,
  labelLimit: number,
  surface: LineMessageActionSurface = "flex",
  warnings?: string[],
): unknown {
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    for (const item of value) {
      normalized.push(normalizeNestedActions(item, labelLimit, surface, warnings));
    }
    return normalized;
  }
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = { ...value };
  for (const [key, nested] of Object.entries(value)) {
    if (key === "action" || key === "defaultAction") {
      if (!isLineAction(nested)) {
        if (surface === "quick-reply") {
          continue;
        }
        if (key === "defaultAction" || (surface === "flex" && value.type !== "button")) {
          delete normalized[key];
          if (warnings && key === "action") {
            warnings.push("Action unavailable: action type is not supported by LINE.");
          }
        } else {
          normalized[key] = unavailableAction("Action", "action type is not supported by LINE.");
        }
        continue;
      }
      const requiresLabel =
        key !== "defaultAction" &&
        (surface === "template" || (surface === "flex" && value.type === "button"));
      const action = normalizeMessageSurfaceAction(nested, labelLimit, surface, requiresLabel);
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
        isLineAction(action)
          ? normalizeMessageSurfaceAction(action, labelLimit, surface, surface === "template")
          : surface === "quick-reply"
            ? action
            : unavailableAction("Action", "action type is not supported by LINE."),
      );
    } else {
      normalized[key] = normalizeNestedActions(nested, labelLimit, surface, warnings);
    }
  }
  return normalized;
}

function normalizeFlexBubbleActions(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "bubble") {
    return normalizeNestedActions(value, 40);
  }

  const warnings: string[] = [];
  const normalized = normalizeNestedActions(value, 40, "flex", warnings);
  if (!isRecord(normalized) || warnings.length === 0) {
    return normalized;
  }

  const warning = {
    type: "text",
    text: [...new Set(warnings)].join("\n"),
    wrap: true,
    size: "sm",
    color: "#B45309",
    margin: "md",
  };
  const body = normalized.body;
  if (isRecord(body) && Array.isArray(body.contents)) {
    normalized.body = { ...body, contents: [...body.contents, warning] };
  } else {
    normalized.body = { type: "box", layout: "vertical", contents: [warning] };
  }
  return normalized;
}

function normalizeFlexContainerActions(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (value.type === "bubble") {
    return normalizeFlexBubbleActions(value);
  }
  if (value.type === "carousel" && Array.isArray(value.contents)) {
    return {
      ...value,
      contents: value.contents.map((bubble) => normalizeFlexBubbleActions(bubble)),
    };
  }
  return normalizeNestedActions(value, 40);
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
    if (!isValidLineUri(action.linkUri)) {
      return unavailableImagemapAction("Link", invalidLineUriReason(action.linkUri), action.area);
    }
    return { ...action, label };
  }

  if (action.type === "message") {
    if (typeof action.text !== "string") {
      return unavailableImagemapAction("Action", "message text is missing.", action.area);
    }
    const text = truncateUtf16Safe(action.text, LINE_IMAGEMAP_MESSAGE_TEXT_LIMIT);
    if (text !== action.text) {
      return unavailableImagemapAction("Action", "message text exceeds LINE's limit.", action.area);
    }
    return { ...action, label, text };
  }

  if (typeof action.clipboardText !== "string" || action.clipboardText.length === 0) {
    return unavailableImagemapAction("Action", "clipboard text must not be empty.", action.area);
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
  if (externalLink === undefined) {
    return { video };
  }
  if (
    !isRecord(externalLink) ||
    !isValidLineUri(externalLink.linkUri) ||
    !hasNonEmptyString(externalLink.label)
  ) {
    const normalizedVideo = { ...video };
    delete normalizedVideo.externalLink;
    return {
      video: normalizedVideo,
      fallbackAction:
        video.area === undefined
          ? undefined
          : unavailableImagemapAction(
              "Link",
              isRecord(externalLink) && isValidLineUri(externalLink.linkUri)
                ? "video link label is missing."
                : invalidLineUriReason(
                    isRecord(externalLink) ? externalLink.linkUri : externalLink,
                  ),
              video.area,
            ),
    };
  }

  const label =
    externalLink.label === undefined
      ? undefined
      : truncateUtf16Safe(externalLink.label, LINE_IMAGEMAP_EXTERNAL_LINK_LABEL_LIMIT) ||
        (externalLink.label ? "…" : "");
  return { video: { ...video, externalLink: { ...externalLink, label } } };
}

export function normalizeLineMessageActions(message: Message): Message {
  let normalized: Message;
  if (message.type === "flex") {
    normalized = {
      ...message,
      contents: normalizeFlexContainerActions(message.contents) as messagingApi.FlexContainer,
    };
  } else if (message.type === "template") {
    const labelLimit = message.template.type === "image_carousel" ? 12 : 20;
    normalized = {
      ...message,
      template: normalizeNestedActions(
        message.template,
        labelLimit,
        message.template.type === "image_carousel" ? "image-carousel" : "template",
      ) as messagingApi.Template,
    };
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

  if (Array.isArray(message.quickReply?.items) && message.quickReply.items.length > 0) {
    const quickReply = normalizeNestedActions(
      message.quickReply,
      LINE_ACTION_LABEL_LIMIT,
      "quick-reply",
    ) as messagingApi.QuickReply;
    // Invalid buttons must not consume LINE's 13 visible quick-reply slots.
    const items: messagingApi.QuickReplyItem[] = [];
    for (const item of quickReply.items ?? []) {
      if (!isRecord(item) || !isValidQuickReplyAction(item.action)) {
        continue;
      }
      const { imageUrl, ...itemWithoutImage } = item;
      items.push({
        ...(imageUrl === undefined || isValidLineUri(imageUrl, true) ? item : itemWithoutImage),
        type: "action",
        action: item.action,
      });
      if (items.length === LINE_QUICK_REPLY_ITEM_LIMIT) {
        break;
      }
    }
    if (items.length > 0) {
      normalized = { ...normalized, quickReply: { ...quickReply, items } };
    } else {
      delete normalized.quickReply;
    }
  } else if (message.quickReply) {
    // LINE rejects empty quick replies; retain the visible message without an invalid action.
    delete normalized.quickReply;
  }

  return normalized;
}

export function normalizeLineAction(action: Action, labelLimit = LINE_ACTION_LABEL_LIMIT): Action {
  if (isUnavailableAction(action)) {
    return action;
  }
  const label =
    action.label === undefined ? undefined : truncateLineActionLabel(action.label, labelLimit);
  const normalizedLabel = label === undefined ? {} : { label };

  if (action.type === "uri") {
    if (!isValidLineUri(action.uri)) {
      return unavailableAction("Link", invalidLineUriReason(action.uri));
    }
    if (
      action.altUri !== undefined &&
      (!isRecord(action.altUri) ||
        (action.altUri.desktop !== undefined && !isValidLineUri(action.altUri.desktop)))
    ) {
      // Raw Flex input may include a malformed optional container; retain the primary link.
      const normalized = { ...action, ...normalizedLabel };
      delete normalized.altUri;
      return normalized;
    }
    return { ...action, ...normalizedLabel };
  }

  if (action.type === "postback") {
    if (typeof action.data !== "string") {
      return unavailableAction("Action", "callback data is missing.");
    }
    const { text: deprecatedText, ...postback } = action;
    const data = truncateLineActionData(action.data);
    if (data !== action.data) {
      // Callback data is opaque and echoed back by LINE. Never dispatch a value
      // whose identity changed merely to satisfy the transport cap.
      return unavailableAction("Action", "callback data exceeds LINE's limit.");
    }
    const legacyText = action.displayText === undefined ? deprecatedText : undefined;
    const text =
      legacyText === undefined
        ? undefined
        : truncateLineActionText(legacyText, LINE_ACTION_DATA_LIMIT);
    const fillInText =
      action.fillInText === undefined
        ? undefined
        : truncateLineActionText(action.fillInText, LINE_ACTION_DATA_LIMIT);
    if (text !== legacyText || fillInText !== action.fillInText) {
      return unavailableAction("Action", "message text exceeds LINE's limit.");
    }
    // Modern displayText wins: LINE rejects requests containing both text fields.
    const normalized = {
      ...postback,
      ...normalizedLabel,
      data,
      displayText:
        action.displayText === undefined
          ? undefined
          : truncateLineActionText(action.displayText, LINE_ACTION_DATA_LIMIT),
      ...(text === undefined ? {} : { text }),
      fillInText,
    };
    if (
      normalized.inputOption !== undefined &&
      !linePostbackInputOptions.has(normalized.inputOption)
    ) {
      delete normalized.inputOption;
    }
    if (normalized.inputOption !== "openKeyboard") {
      delete normalized.fillInText;
    }
    return normalized;
  }

  if (action.type === "datetimepicker") {
    if (
      typeof action.data !== "string" ||
      (action.mode !== "date" && action.mode !== "time" && action.mode !== "datetime")
    ) {
      return unavailableAction("Action", "date picker data or mode is missing.");
    }
    const data = truncateLineActionData(action.data);
    if (data !== action.data) {
      return unavailableAction("Action", "callback data exceeds LINE's limit.");
    }
    const normalized = { ...action, ...normalizedLabel, data };
    for (const field of ["initial", "min", "max"] as const) {
      if (
        normalized[field] !== undefined &&
        !isValidLinePickerValue(normalized[field], action.mode)
      ) {
        delete normalized[field];
      }
    }
    if (
      normalized.min !== undefined &&
      normalized.max !== undefined &&
      normalized.min.toUpperCase() >= normalized.max.toUpperCase()
    ) {
      delete normalized.min;
      delete normalized.max;
    }
    return normalized;
  }

  if (action.type === "message") {
    if (typeof action.text !== "string") {
      return unavailableAction("Action", "message text is missing.");
    }
    const text = truncateLineActionText(action.text, LINE_ACTION_DATA_LIMIT);
    if (text !== action.text) {
      return unavailableAction("Action", "message text exceeds LINE's limit.");
    }
    return {
      ...action,
      ...normalizedLabel,
      text,
    };
  }

  if (action.type === "clipboard") {
    if (typeof action.clipboardText !== "string" || action.clipboardText.length === 0) {
      return unavailableAction("Action", "clipboard text must not be empty.");
    }
    if (
      truncateUtf16Safe(action.clipboardText, LINE_CLIPBOARD_TEXT_LIMIT) !== action.clipboardText
    ) {
      return unavailableAction("Action", "clipboard text exceeds LINE's limit.");
    }
    return { ...action, ...normalizedLabel };
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
    return { ...action, ...normalizedLabel, data };
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
