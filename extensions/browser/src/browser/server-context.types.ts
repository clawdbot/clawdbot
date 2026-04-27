import type { Server } from "node:http";
import type { RunningChrome } from "./chrome.js";
import type { BrowserTab, BrowserTransport } from "./client.types.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

export type { BrowserTab };

/**
 * Runtime state for a single profile's Chrome instance.
 */
export type ProfileRuntimeState = {
  profile: ResolvedBrowserProfile;
  running: RunningChrome | null;
  ensureBrowserAvailable?: { key: string; promise: Promise<void> } | null;
  managedLaunchFailure?: {
    consecutiveFailures: number;
    lastFailureAt: number;
    cooldownUntil?: number;
    lastError: string;
  };
  /** Sticky tab selection when callers omit targetId (keeps snapshot+act consistent). */
  lastTargetId?: string | null;
  /** Stable, user-facing tab aliases scoped to this profile runtime. */
  tabAliases?: {
    nextTabNumber: number;
    byTargetId: Record<string, { tabId: string; label?: string; url?: string }>;
  };
  reconcile?: {
    previousProfile: ResolvedBrowserProfile;
    reason: string;
  } | null;
};

export type BrowserServerState = {
  server?: Server | null;
  port: number;
  resolved: ResolvedBrowserConfig;
  profiles: Map<string, ProfileRuntimeState>;
  stopTrackedTabCleanup?: () => void;
};

type BrowserProfileActions = {
  ensureBrowserAvailable: (opts?: { headless?: boolean }) => Promise<void>;
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  isTransportAvailable: (timeoutMs?: number) => Promise<boolean>;
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string, opts?: { label?: string }) => Promise<BrowserTab>;
  labelTab: (targetId: string, label: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  resetProfile: () => Promise<{ moved: boolean; from: string; to?: string }>;
};

export type BrowserRouteContext = {
  state: () => BrowserServerState;
  forProfile: (profileName?: string) => ProfileContext;
  listProfiles: () => Promise<ProfileStatus[]>;
  // Legacy methods delegate to default profile for backward compatibility
  mapTabError: (err: unknown) => { status: number; message: string } | null;
} & BrowserProfileActions;

export type ProfileContext = {
  profile: ResolvedBrowserProfile;
} & BrowserProfileActions;

export type ProfileStatus = {
  name: string;
  transport: BrowserTransport;
  cdpPort: number | null;
  cdpUrl: string | null;
  color: string;
  driver: ResolvedBrowserProfile["driver"];
  running: boolean;
  tabCount: number;
  isDefault: boolean;
  isRemote: boolean;
  missingFromConfig?: boolean;
  reconcileReason?: string | null;
};

export type ContextOptions = {
  getState: () => BrowserServerState | null;
  onEnsureAttachTarget?: (profile: ResolvedBrowserProfile) => Promise<void>;
  refreshConfigFromDisk?: boolean;
};
