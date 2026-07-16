import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";

export function resolveAssistantAttachmentAuthToken(state: {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  password?: string | null;
  settings?: { token?: string | null } | null;
}) {
  return resolveControlUiAuthToken(state);
}

export function dismissChatError(state: {
  chatError?: string | null;
  lastError: string | null;
  lastErrorCode?: string | null;
}) {
  state.lastError = null;
  state.lastErrorCode = null;
  state.chatError = null;
}
