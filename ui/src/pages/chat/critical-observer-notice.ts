import type { SessionObserverDigest } from "@openclaw/gateway-protocol";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { isCriticalObserverHealth } from "../../lib/observer-digest.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  uiSessionEventMatches,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";

const NOTICE_TRACKER_LIMIT = 256;

export class CriticalObserverNoticeTracker {
  private readonly seen = new Map<string, { health: string; revision: number }>();

  clear(): void {
    this.seen.clear();
  }

  record(params: {
    sessionKey: string;
    agentId?: string;
    health: string;
    revision: number;
  }): boolean {
    const sessionKey = normalizeSessionKeyForUiComparison(params.sessionKey);
    const key =
      isUiGlobalSessionKey(sessionKey) && params.agentId
        ? `${sessionKey}:${normalizeAgentId(params.agentId)}`
        : sessionKey;
    const previous = this.seen.get(key);
    // Gateway revision floors keep revisions session-monotonic across run
    // rollover, so a gap reliably means this connection missed digest state.
    if (previous && params.revision <= previous.revision) {
      return false;
    }
    const shouldAnnounce =
      isCriticalObserverHealth(params.health) &&
      (!previous || previous.health !== params.health || params.revision > previous.revision + 1);
    if (!previous && this.seen.size >= NOTICE_TRACKER_LIMIT) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    this.seen.delete(key);
    this.seen.set(key, { health: params.health, revision: params.revision });
    return shouldAnnounce;
  }
}

export function showCriticalSessionObserverNotice(params: {
  payload: unknown;
  selectedSessionKey: string;
  sessionHost: UiSessionDefaultsHost;
  sessions: readonly GatewaySessionRow[];
  tracker: CriticalObserverNoticeTracker;
  onOpen: (sessionKey: string, agentId?: string) => void;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const digest = params.payload as Partial<SessionObserverDigest>;
  const sessionKey = typeof digest.sessionKey === "string" ? digest.sessionKey.trim() : "";
  const headline = typeof digest.headline === "string" ? digest.headline.trim() : "";
  const revision = digest.revision;
  if (
    !sessionKey ||
    !headline ||
    typeof digest.health !== "string" ||
    revision === undefined ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    return;
  }
  const shouldAnnounce = params.tracker.record({
    sessionKey,
    agentId: digest.agentId,
    health: digest.health,
    revision,
  });
  if (
    !shouldAnnounce ||
    uiSessionEventMatches(
      { ...params.sessionHost, sessionKey: params.selectedSessionKey },
      sessionKey,
      digest.agentId,
    )
  ) {
    return;
  }
  const row = params.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  const label = resolveSessionDisplayName(sessionKey, row);
  showToast({
    message: `${t("sessionsView.attentionRequired")}: ${label} — ${headline}`,
    variant: digest.health === "failed" ? "danger" : "warning",
    actionLabel: t("sessionsView.openSession"),
    onAction: () =>
      digest.agentId ? params.onOpen(sessionKey, digest.agentId) : params.onOpen(sessionKey),
  });
}
