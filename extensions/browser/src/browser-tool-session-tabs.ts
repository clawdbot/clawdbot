/**
 * Session tracking for tabs created through the browser tool.
 */
import type { BrowserTabOwnership } from "./browser/client.types.js";

type SessionTabParams = {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

type SessionTabRegistry = {
  trackSessionBrowserTab: (params: SessionTabParams) => void;
  touchSessionBrowserTab: (params: SessionTabParams) => void;
  untrackSessionBrowserTab: (params: SessionTabParams) => void;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOpenedTab(result: unknown): {
  targetId?: string;
  aliases: string[];
  profile?: string;
  ownership?: BrowserTabOwnership;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { aliases: [] };
  }
  const opened = result as Record<string, unknown>;
  const targetId = readString(opened.targetId);
  const aliases = [
    targetId,
    readString(opened.tabId),
    readString(opened.label),
    readString(opened.suggestedTargetId),
  ].filter((alias): alias is string => Boolean(alias));
  const profile = readString(opened.resolvedProfile);
  const rawOwnership =
    opened.ownership && typeof opened.ownership === "object"
      ? (opened.ownership as BrowserTabOwnership)
      : undefined;
  // Older browser hosts do not return resolvedProfile. Their durable fingerprint
  // cannot prove which configured profile owns the tab, so keep that tab volatile.
  const ownership = rawOwnership?.status === "durable" && !profile ? undefined : rawOwnership;
  return { targetId, aliases: [...new Set(aliases)], profile, ownership };
}

export function stripBrowserOpenInternalMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const {
    ownership: _ownership,
    resolvedProfile: _resolvedProfile,
    ...agentVisible
  } = value as Record<string, unknown>;
  return agentVisible;
}

async function trackOpenedBrowserTab(params: {
  result: unknown;
  sessionKey?: string;
  fallbackProfile?: string;
  baseUrl?: string;
  track: SessionTabRegistry["trackSessionBrowserTab"];
  closeTab: (targetId: string, profile?: string) => Promise<void>;
}): Promise<void> {
  const opened = readOpenedTab(params.result);
  const profile = opened.profile ?? params.fallbackProfile;
  try {
    params.track({
      sessionKey: params.sessionKey,
      targetId: opened.targetId,
      baseUrl: params.baseUrl,
      profile,
      ...(params.fallbackProfile && opened.profile && opened.profile !== params.fallbackProfile
        ? { profileAliases: [params.fallbackProfile] }
        : {}),
      // Sandbox/browser-bridge tabs belong to a different browser process.
      // Keep them process-local even if that server returned durable metadata.
      ownership: params.baseUrl ? undefined : opened.ownership,
      aliases: opened.aliases,
    });
  } catch (trackingError) {
    if (!opened.targetId) {
      throw trackingError;
    }
    try {
      await params.closeTab(opened.targetId, profile);
    } catch (closeError) {
      throw Object.assign(
        new Error("Failed to register browser tab cleanup and close the newly opened tab", {
          cause: closeError,
        }),
        {
          name: "BrowserTabTrackingCompensationError",
          errors: [trackingError, closeError],
        },
      );
    }
    throw trackingError;
  }
}

export function createBrowserToolSessionTabs(params: {
  sessionKey?: string;
  requestedProfile?: string;
  defaultProfile: string;
  baseUrl?: string;
  isHostFallbackActive?: () => boolean;
  registry: SessionTabRegistry;
}) {
  const profile = params.requestedProfile ?? params.defaultProfile;
  const isTrackedRoute = () => !params.isHostFallbackActive || params.isHostFallbackActive();
  const trackedBaseUrl = () => (params.isHostFallbackActive ? undefined : params.baseUrl);
  const trackedProfile = () => (trackedBaseUrl() && !params.requestedProfile ? undefined : profile);
  const identity = (targetId: string) => ({
    sessionKey: params.sessionKey,
    targetId,
    baseUrl: trackedBaseUrl(),
    profile: trackedProfile(),
  });
  return {
    touch: (targetId: string | undefined): void => {
      if (targetId && isTrackedRoute()) {
        params.registry.touchSessionBrowserTab(identity(targetId));
      }
    },
    untrack: (targetId: string | undefined): void => {
      if (targetId && isTrackedRoute()) {
        params.registry.untrackSessionBrowserTab(identity(targetId));
      }
    },
    trackOpened: async (
      result: unknown,
      closeTab: (targetId: string, openedProfile?: string) => Promise<void>,
    ): Promise<void> => {
      if (!isTrackedRoute()) {
        return;
      }
      const baseUrl = trackedBaseUrl();
      await trackOpenedBrowserTab({
        result,
        sessionKey: params.sessionKey,
        fallbackProfile: baseUrl && !params.requestedProfile ? undefined : profile,
        baseUrl,
        track: params.registry.trackSessionBrowserTab,
        closeTab,
      });
    },
  };
}
