// Shared shapes for the durable session tab registry tests. The registry module
// is imported fresh per test, so its types are re-declared here rather than
// exported from production code.
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { BrowserTabOwnership } from "./client.types.js";

type TabIdentity = {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

export type DurableRecord = {
  version: 1;
  sessionKey: string;
  nativeTargetId: string;
  profile: string;
  profileAliases?: string[];
  profileFingerprint: string;
  browserInstanceFingerprint: string;
  interactionTargetKind: "native" | "opaque";
  trackedAt: number;
  lastUsedAt: number;
  cleanupRequestedAt?: number;
  cleanupAttemptToken?: string;
  cleanupKind?: "lifecycle" | "sweep";
};

export type DurableTab = DurableRecord & { kind: "durable"; storageKey: string };

export type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
}) => Promise<void>;

type CleanupParams = {
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: { shouldClose: () => boolean },
  ) => Promise<CloseTrackedCdpTargetResult>;
  onWarn?: (message: string) => void;
};

export type RegistryModule = {
  trackSessionBrowserTab(params: TabIdentity & { now?: number }): void;
  touchSessionBrowserTab(params: TabIdentity & { now?: number }): void;
  untrackSessionBrowserTab(params: TabIdentity): void;
  closeTrackedBrowserTabsForSessions(
    params: CleanupParams & { sessionKeys: Array<string | undefined>; now?: number },
  ): Promise<number>;
  sweepTrackedBrowserTabs(
    params: CleanupParams & {
      now?: number;
      idleMs?: number;
      maxTabsPerSession?: number;
      sessionFilter?: (sessionKey: string) => boolean;
    },
  ): Promise<number>;
};

export const durableOwnership = (
  nativeTargetId: string,
  profileFingerprint = "test-profile-fingerprint",
  browserInstanceFingerprint = "test-browser-instance-fingerprint",
): BrowserTabOwnership => ({
  status: "durable",
  nativeTargetId,
  profileFingerprint,
  browserInstanceFingerprint,
});
