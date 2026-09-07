import type { SessionEntry } from "../../config/sessions/types.js";
import {
  normalizeSessionToolOverrides,
  sessionToolOverridesEqual,
} from "../session-tool-overrides.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";

export const SESSION_SETTINGS_CHANGED_ERROR_REASON = "session-settings-changed";
type AdmittedChatSendSessionSettings =
  | Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">>
  | undefined;

export function captureAdmittedChatSendSessionSettings(params: {
  commit: boolean;
  entry: SessionEntry | undefined;
  expectedPermissionMode: NormalizedChatSendRequest["p"]["expectedPermissionMode"];
  expectedToolOverrides: NormalizedChatSendRequest["p"]["expectedToolOverrides"];
}): AdmittedChatSendSessionSettings {
  const { entry, expectedPermissionMode, expectedToolOverrides } = params;
  if (
    (expectedPermissionMode !== undefined &&
      (entry?.permissionMode ?? null) !== expectedPermissionMode) ||
    (expectedToolOverrides !== undefined &&
      !sessionToolOverridesEqual(entry?.toolOverrides, expectedToolOverrides))
  ) {
    throw new Error(SESSION_SETTINGS_CHANGED_ERROR_REASON);
  }
  if (!params.commit) {
    return undefined;
  }
  return Object.freeze({
    permissionMode: entry?.permissionMode,
    toolOverrides: normalizeSessionToolOverrides(entry?.toolOverrides),
  });
}
