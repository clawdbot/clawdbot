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

const MAX_TRACKED_SESSION_ROWS = 256;

export class SessionParticipationTracker {
  private readonly lastBlocked = new Map<string, boolean>();

  reset(): void {
    this.lastBlocked.clear();
  }

  resolve(params: {
    catalog: boolean;
    listLoading: boolean;
    sessionKey: string;
    session: Pick<GatewaySessionRow, "sharingRole" | "visibility"> | undefined;
  }): boolean {
    if (params.catalog) {
      return false;
    }
    if (params.session) {
      const blocked =
        params.session.visibility === "draft"
          ? params.session.sharingRole !== "admin" && params.session.sharingRole !== "owner"
          : params.session.visibility !== undefined &&
            params.session.visibility !== "shared" &&
            params.session.sharingRole === "viewer";
      this.remember(params.sessionKey, blocked);
      return blocked;
    }
    // The selected session has no row. Absence is NOT a revocation signal:
    // filtering, search, pagination, and deletion all remove a row the caller
    // can still write to, so inferring a block would wrongly disable a valid
    // session. Block only on a positively observed restricted state above.
    // During an in-flight refresh, hold the last known block so a restricted
    // session does not flicker enabled; a completed absence never blocks. The
    // redaction case (a session hidden from a non-owner) is handled once the
    // explicit revocation signal lands (openclaw/openclaw#112760).
    if (params.listLoading) {
      return this.lastBlocked.get(params.sessionKey) === true;
    }
    return false;
  }

  private remember(sessionKey: string, blocked: boolean): void {
    this.lastBlocked.delete(sessionKey);
    this.lastBlocked.set(sessionKey, blocked);
    if (this.lastBlocked.size <= MAX_TRACKED_SESSION_ROWS) {
      return;
    }
    const oldest = this.lastBlocked.keys().next().value;
    if (oldest) {
      this.lastBlocked.delete(oldest);
    }
  }
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
