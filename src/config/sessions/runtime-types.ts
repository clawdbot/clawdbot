// Runtime session types describe the store hooks shared across config, gateway, and channels.
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionMaintenanceMode } from "../types.base.js";
import type { SessionEntry, GroupKeyResolution } from "./types.js";

/** Runtime hook for reading a session store entry timestamp. */
export type ReadSessionUpdatedAt = (params: {
  storePath: string;
  sessionKey: string;
}) => number | undefined;

export type SessionMaintenanceWarningRuntime = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};

export type ResolvedSessionMaintenanceConfigRuntime = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
};

export type SessionMaintenanceApplyReportRuntime = {
  mode: SessionMaintenanceMode;
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: Record<string, unknown> | null;
};

export type SaveSessionStoreOptions = {
  skipMaintenance?: boolean;
  activeSessionKey?: string;
  onWarn?: (warning: SessionMaintenanceWarningRuntime) => void | Promise<void>;
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReportRuntime) => void | Promise<void>;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfigRuntime>;
};

export type SaveSessionStore = (
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
) => Promise<void>;

export type RecordSessionMetaFromInbound = (params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;

export type UpdateLastRoute = (params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;
