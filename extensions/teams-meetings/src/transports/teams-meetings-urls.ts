import type { MeetingBrowserCandidateTab } from "openclaw/plugin-sdk/meeting-runtime";

type TeamsMeetingIdentity = { kind: "work"; key: string } | { kind: "consumer"; key: string };

function parseTeamsMeetingIdentity(url: string | undefined): TeamsMeetingIdentity | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) {
      return undefined;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "teams.microsoft.com") {
      const match = parsed.pathname.match(/^\/l\/meetup-join\/([^/]+)(?:\/0)?\/?$/i);
      if (!match?.[1]) {
        return undefined;
      }
      const threadId = decodeURIComponent(match[1]);
      if (!/^19:[^/]+@thread\.(?:v2|tacv2)$/i.test(threadId)) {
        return undefined;
      }
      return { kind: "work", key: threadId };
    }
    if (hostname === "teams.live.com") {
      const match = parsed.pathname.match(/^\/meet\/([^/]+)\/?$/i);
      if (!match?.[1]) {
        return undefined;
      }
      const meetCode = decodeURIComponent(match[1]);
      if (!/^[a-z0-9_-]+$/i.test(meetCode)) {
        return undefined;
      }
      const password = parsed.searchParams.get("p");
      return {
        kind: "consumer",
        key: `${meetCode.toLowerCase()}:p:${encodeURIComponent(password ?? "")}`,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeTeamsMeetingUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Microsoft Teams meeting URL is required");
  }
  const value = input.trim();
  if (!parseTeamsMeetingIdentity(value)) {
    throw new Error(
      "Microsoft Teams meeting URL must use https://teams.microsoft.com/l/meetup-join/... or https://teams.live.com/meet/<id>",
    );
  }
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeTeamsMeetingUrlForReuse(url: string | undefined): string | undefined {
  const identity = parseTeamsMeetingIdentity(url);
  return identity ? `teams-${identity.kind}:${identity.key}` : undefined;
}

export function isSameTeamsMeetingUrl(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const normalizedLeft = normalizeTeamsMeetingUrlForReuse(left);
  const normalizedRight = normalizeTeamsMeetingUrlForReuse(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function isRecoverableTeamsMeetingTab(
  tab: MeetingBrowserCandidateTab,
  url?: string,
): boolean {
  if (url) {
    return isSameTeamsMeetingUrl(tab.url, url);
  }
  if (normalizeTeamsMeetingUrlForReuse(tab.url)) {
    return true;
  }
  try {
    const hostname = new URL(tab.url ?? "").hostname.toLowerCase();
    return (
      (hostname === "login.microsoftonline.com" || hostname.endsWith(".microsoftonline.com")) &&
      /sign in|microsoft|teams/i.test(tab.title ?? "")
    );
  } catch {
    return false;
  }
}
