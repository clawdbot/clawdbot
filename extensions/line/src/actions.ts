// Line plugin module implements actions behavior.
import type { messagingApi } from "@line/bot-sdk";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export type Action = messagingApi.Action;
type Message = messagingApi.Message;
const LINE_ACTION_LABEL_LIMIT = 20;
const LINE_ACTION_DATA_LIMIT = 300;
const LINE_ACTION_URI_LIMIT = 1000;
const LINE_CLIPBOARD_TEXT_LIMIT = 1000;
const LINE_RICH_MENU_ALIAS_LIMIT = 32;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncateLineActionText(text: string, limit: number): string {
  let result = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const codePointCount = [...segment].length;
    if (count + codePointCount > limit) {
      break;
    }
    result += segment;
    count += codePointCount;
  }
  return result;
}

export function truncateLineActionLabel(label: string, limit = LINE_ACTION_LABEL_LIMIT): string {
  return truncateLineActionText(label, limit);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLineAction(value: unknown): value is Action {
  return isRecord(value) && typeof value.type === "string" && actionTypes.has(value.type);
}

function isUnavailableAction(action: Action): action is UnavailableAction {
  return (action as Partial<UnavailableAction>)[unavailableActionMarker] === true;
}

function normalizeNestedActions(value: unknown, labelLimit: number, warnings?: string[]): unknown {
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    for (const item of value) {
      normalized.push(normalizeNestedActions(item, labelLimit, warnings));
    }
    return normalized;
  }
  if (!isRecord(value)) {
    return value;
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
      normalized[key] = normalizeNestedActions(nested, labelLimit, warnings);
    }
  }
  return normalized;
}

function normalizeFlexBubbleActions(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "bubble") {
    return normalizeNestedActions(value, 40);
  }

  const warnings: string[] = [];
  const normalized = normalizeNestedActions(value, 40, warnings);
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
      template: normalizeNestedActions(message.template, labelLimit) as messagingApi.Template,
    };
  } else {
    normalized = { ...message };
  }

  if (message.quickReply) {
    normalized = {
      ...normalized,
      quickReply: normalizeNestedActions(message.quickReply, 20) as messagingApi.QuickReply,
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
