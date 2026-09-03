import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getSafeLocalStorage } from "../local-storage.ts";

export const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite";

export type CommunityInviteState = {
  dismissedAtMs?: number;
};

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Null means stored state cannot be trusted; an empty object is a new browser origin. */
export function readCommunityInviteState(): CommunityInviteState | null {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(COMMUNITY_INVITE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const dismissedAtMs = timestamp(value.dismissedAtMs);
  if (dismissedAtMs === undefined) {
    return null;
  }
  return { dismissedAtMs };
}

function writeCommunityInviteState(state: CommunityInviteState): boolean {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return false;
  }
  try {
    const serialized = JSON.stringify(state);
    storage.setItem(COMMUNITY_INVITE_KEY, serialized);
    return storage.getItem(COMMUNITY_INVITE_KEY) === serialized;
  } catch {
    return false;
  }
}

export function dismissCommunityInvite(now = Date.now()): CommunityInviteState | null {
  const current = readCommunityInviteState();
  if (current === null) {
    return null;
  }
  const next = { dismissedAtMs: now };
  return writeCommunityInviteState(next) ? next : null;
}

export function resolveCommunityInviteVisibility({
  dismissedAtMs,
}: {
  dismissedAtMs?: number | null;
}): "visible" | "hidden" {
  return dismissedAtMs === undefined ? "visible" : "hidden";
}
