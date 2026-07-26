// Resolves which tab an untargeted recover_current_tab call may reattach to,
// so recovery never arms mic/captions on an unrelated Meet tab in a shared
// Chrome profile (see #113990).
import type { GoogleMeetTransport } from "./config.js";
import { isBrowserTransport } from "./runtime-session.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./transports/google-meet-platform-adapter.js";
import type { GoogleMeetSession } from "./transports/types.js";

interface RecoverOwnership {
  trackedMeetingUrl?: string;
  trackedTargetId?: string;
}

/** Prefer active session tab for this transport; else createViaBrowser tab. */
export function resolveRecoverOwnership(params: {
  url?: string;
  transport: GoogleMeetTransport;
  sessions: readonly GoogleMeetSession[];
  createdBrowserTabs: ReadonlyMap<string, string>;
}): RecoverOwnership {
  const sessions = params.sessions.filter(
    (session) =>
      isBrowserTransport(session.transport) &&
      session.transport === params.transport &&
      Boolean(session.chrome?.browserTab?.targetId),
  );
  const urlMatched = params.url
    ? sessions.find((session) =>
        GOOGLE_MEET_PLATFORM_ADAPTER.urls.isSameMeeting(session.url, params.url),
      )
    : undefined;
  const ownedSession =
    urlMatched ??
    (!params.url
      ? [...sessions].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      : undefined);
  if (ownedSession?.chrome?.browserTab?.targetId) {
    return {
      trackedMeetingUrl: ownedSession.url,
      trackedTargetId: ownedSession.chrome.browserTab.targetId,
    };
  }
  for (const [key, meetingUri] of params.createdBrowserTabs) {
    const sep = key.indexOf(":");
    const nodeId = sep >= 0 ? key.slice(0, sep) : "";
    const targetId = sep >= 0 ? key.slice(sep + 1) : key;
    if (!targetId) {
      continue;
    }
    // createViaBrowser keys as `${nodeId}:${targetId}` (local often empty nodeId).
    if (params.transport === "chrome-node" && !nodeId) {
      continue;
    }
    if (params.transport === "chrome" && nodeId && nodeId !== "local") {
      continue;
    }
    if (params.url && !GOOGLE_MEET_PLATFORM_ADAPTER.urls.isSameMeeting(meetingUri, params.url)) {
      continue;
    }
    return { trackedMeetingUrl: meetingUri, trackedTargetId: targetId };
  }
  if (params.url) {
    return { trackedMeetingUrl: params.url };
  }
  return {};
}
