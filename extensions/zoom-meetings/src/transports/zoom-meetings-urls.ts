import type { MeetingBrowserCandidateTab } from "openclaw/plugin-sdk/meeting-runtime";

type ZoomMeetingIdentity = {
  kind: "invitation" | "web-client";
  meetingId: string;
  passcode?: string;
};

function isZoomHostname(hostname: string): boolean {
  return hostname === "zoom.us" || hostname.endsWith(".zoom.us");
}

function parseZoomMeetingIdentity(url: string | undefined): ZoomMeetingIdentity | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !isZoomHostname(parsed.hostname.toLowerCase())
    ) {
      return undefined;
    }
    const invitation = parsed.pathname.match(/^\/j\/(\d{9,11})\/?$/);
    const webClient =
      parsed.hostname.toLowerCase() === "app.zoom.us"
        ? parsed.pathname.match(/^\/wc\/(\d{9,11})\/join\/?$/)
        : undefined;
    const meetingId = invitation?.[1] ?? webClient?.[1];
    return meetingId
      ? {
          kind: invitation ? "invitation" : "web-client",
          meetingId,
          passcode: parsed.searchParams.get("pwd") || undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeZoomMeetingUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Zoom meeting URL is required");
  }
  const value = input.trim();
  if (!parseZoomMeetingIdentity(value)) {
    throw new Error("Zoom meeting URL must use https://<account>.zoom.us/j/<meeting-id>");
  }
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeZoomMeetingUrlForReuse(url: string | undefined): string | undefined {
  const identity = parseZoomMeetingIdentity(url);
  return identity ? `zoom:${identity.meetingId}` : undefined;
}

export function isSameZoomMeetingUrl(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeZoomMeetingUrlForReuse(left);
  const normalizedRight = normalizeZoomMeetingUrlForReuse(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function hasSameZoomMeetingJoinCredential(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const leftIdentity = parseZoomMeetingIdentity(left);
  const rightIdentity = parseZoomMeetingIdentity(right);
  return Boolean(
    leftIdentity &&
    rightIdentity &&
    leftIdentity.meetingId === rightIdentity.meetingId &&
    leftIdentity.passcode === rightIdentity.passcode,
  );
}

export function isRecoverableZoomMeetingTab(
  tab: MeetingBrowserCandidateTab,
  url?: string,
): boolean {
  if (url) {
    const tabIdentity = parseZoomMeetingIdentity(tab.url);
    const requestedIdentity = parseZoomMeetingIdentity(url);
    if (
      !tabIdentity ||
      !requestedIdentity ||
      tabIdentity.meetingId !== requestedIdentity.meetingId
    ) {
      return false;
    }
    return tabIdentity.kind !== "invitation" || requestedIdentity.kind !== "invitation"
      ? true
      : tabIdentity.passcode === requestedIdentity.passcode;
  }
  if (normalizeZoomMeetingUrlForReuse(tab.url)) {
    return true;
  }
  try {
    const hostname = new URL(tab.url ?? "").hostname.toLowerCase();
    return isZoomHostname(hostname) && /sign in|verification|zoom/i.test(tab.title ?? "");
  } catch {
    return false;
  }
}
