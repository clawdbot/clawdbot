import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";

type SelectedSessionProjectionState = {
  chatEffectiveQueueMode?: GatewaySessionRow["effectiveQueueMode"];
  chatQueueModeOverride?: GatewaySessionRow["queueMode"];
  selectedChatSessionArchived: boolean;
};

export function applySelectedSessionProjection(
  state: SelectedSessionProjectionState,
  session: GatewaySessionRow | undefined,
): session is GatewaySessionRow {
  if (!session) {
    return false;
  }
  state.selectedChatSessionArchived = session.archived === true;
  state.chatQueueModeOverride = session.queueMode;
  state.chatEffectiveQueueMode = session.effectiveQueueMode;
  return true;
}

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
