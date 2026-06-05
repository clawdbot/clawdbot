// Control UI controller manages presence gateway state.
import type { GatewayBrowserClient } from "../gateway.ts";
import type { PresenceEntry } from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type PresenceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
};

export async function loadPresence(state: PresenceState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.presenceLoading) {
    return;
  }
  state.presenceLoading = true;
  state.presenceError = null;
  state.presenceStatus = null;
  try {
    const res = await state.client.request("system-presence", {});
    if (Array.isArray(res)) {
      state.presenceEntries = res;
      state.presenceStatus = res.length === 0 ? "No instances yet." : null;
    } else {
      state.presenceEntries = [];
      state.presenceStatus = "No presence payload.";
    }
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.presenceEntries = [];
      state.presenceStatus = null;
      state.presenceError = formatMissingOperatorReadScopeMessage("instance presence");
    } else {
      state.presenceError = String(err);
    }
  } finally {
    state.presenceLoading = false;
  }
}
