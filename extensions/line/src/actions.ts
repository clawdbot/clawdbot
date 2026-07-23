// Line plugin module implements actions behavior.
import type { messagingApi } from "@line/bot-sdk";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export type Action = messagingApi.Action;
const LINE_ACTION_LABEL_LIMIT = 20;
const LINE_ACTION_DATA_LIMIT = 300;
const LINE_ACTION_URI_LIMIT = 1000;

export function truncateLineActionLabel(label: string, limit = LINE_ACTION_LABEL_LIMIT): string {
  return truncateUtf16Safe(label, limit);
}

export function truncateLineActionData(data: string): string {
  return truncateUtf16Safe(data, LINE_ACTION_DATA_LIMIT);
}

/**
 * Create a message action (sends text when tapped)
 */
export function messageAction(label: string, text?: string): Action {
  return {
    type: "message",
    label: truncateLineActionLabel(label),
    text: text ?? label,
  };
}

/**
 * Create a URI action (opens a URL when tapped)
 */
export function uriAction(label: string, uri: string): Action {
  return {
    type: "uri",
    label: truncateLineActionLabel(label),
    uri: truncateUtf16Safe(uri, LINE_ACTION_URI_LIMIT),
  };
}

/**
 * Create a postback action (sends data to webhook when tapped)
 */
export function postbackAction(label: string, data: string, displayText?: string): Action {
  return {
    type: "postback",
    label: truncateLineActionLabel(label),
    data: truncateLineActionData(data),
    displayText: displayText === undefined ? undefined : truncateLineActionData(displayText),
  };
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
  return {
    type: "datetimepicker",
    label: truncateLineActionLabel(label),
    data: truncateLineActionData(data),
    mode,
    initial: options?.initial,
    max: options?.max,
    min: options?.min,
  };
}
