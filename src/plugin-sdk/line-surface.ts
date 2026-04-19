// Manual facade. Keep loader boundary explicit.
import type { BaseProbeResult } from "../channels/plugins/types.public.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

type FacadeFunction = (...args: unknown[]) => unknown;
type FacadeModule = Record<
  | "createActionCard"
  | "createAgendaCard"
  | "createAppleTvRemoteCard"
  | "createDeviceControlCard"
  | "createEventCard"
  | "createImageCard"
  | "createInfoCard"
  | "createListCard"
  | "createMediaPlayerCard"
  | "createReceiptCard"
  | "listLineAccountIds"
  | "normalizeAccountId"
  | "processLineMessage"
  | "resolveDefaultLineAccountId"
  | "resolveExactLineGroupConfigKey"
  | "resolveLineAccount",
  FacadeFunction
> & {
  LineConfigSchema: object;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "line",
    artifactBasename: "runtime-api.js",
  });
}
export const createActionCard: FacadeModule["createActionCard"] = ((...args) =>
  loadFacadeModule()["createActionCard"](...args)) as FacadeModule["createActionCard"];
export const createAgendaCard: FacadeModule["createAgendaCard"] = ((...args) =>
  loadFacadeModule()["createAgendaCard"](...args)) as FacadeModule["createAgendaCard"];
export const createAppleTvRemoteCard: FacadeModule["createAppleTvRemoteCard"] = ((...args) =>
  loadFacadeModule()["createAppleTvRemoteCard"](
    ...args,
  )) as FacadeModule["createAppleTvRemoteCard"];
export const createDeviceControlCard: FacadeModule["createDeviceControlCard"] = ((...args) =>
  loadFacadeModule()["createDeviceControlCard"](
    ...args,
  )) as FacadeModule["createDeviceControlCard"];
export const createEventCard: FacadeModule["createEventCard"] = ((...args) =>
  loadFacadeModule()["createEventCard"](...args)) as FacadeModule["createEventCard"];
export const createImageCard: FacadeModule["createImageCard"] = ((...args) =>
  loadFacadeModule()["createImageCard"](...args)) as FacadeModule["createImageCard"];
export const createInfoCard: FacadeModule["createInfoCard"] = ((...args) =>
  loadFacadeModule()["createInfoCard"](...args)) as FacadeModule["createInfoCard"];
export const createListCard: FacadeModule["createListCard"] = ((...args) =>
  loadFacadeModule()["createListCard"](...args)) as FacadeModule["createListCard"];
export const createMediaPlayerCard: FacadeModule["createMediaPlayerCard"] = ((...args) =>
  loadFacadeModule()["createMediaPlayerCard"](...args)) as FacadeModule["createMediaPlayerCard"];
export const createReceiptCard: FacadeModule["createReceiptCard"] = ((...args) =>
  loadFacadeModule()["createReceiptCard"](...args)) as FacadeModule["createReceiptCard"];
export const LineConfigSchema: FacadeModule["LineConfigSchema"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["LineConfigSchema"],
);
export const listLineAccountIds: FacadeModule["listLineAccountIds"] = ((...args) =>
  loadFacadeModule()["listLineAccountIds"](...args)) as FacadeModule["listLineAccountIds"];
export const normalizeAccountId: FacadeModule["normalizeAccountId"] = ((...args) =>
  loadFacadeModule()["normalizeAccountId"](...args)) as FacadeModule["normalizeAccountId"];
export const processLineMessage: FacadeModule["processLineMessage"] = ((...args) =>
  loadFacadeModule()["processLineMessage"](...args)) as FacadeModule["processLineMessage"];
export const resolveDefaultLineAccountId: FacadeModule["resolveDefaultLineAccountId"] = ((
  ...args
) =>
  loadFacadeModule()["resolveDefaultLineAccountId"](
    ...args,
  )) as FacadeModule["resolveDefaultLineAccountId"];
export const resolveExactLineGroupConfigKey: FacadeModule["resolveExactLineGroupConfigKey"] = ((
  ...args
) =>
  loadFacadeModule()["resolveExactLineGroupConfigKey"](
    ...args,
  )) as FacadeModule["resolveExactLineGroupConfigKey"];
export const resolveLineAccount: FacadeModule["resolveLineAccount"] = ((...args) =>
  loadFacadeModule()["resolveLineAccount"](...args)) as FacadeModule["resolveLineAccount"];
export type Action = Record<string, unknown>;

export interface ListItem {
  title: string;
  subtitle?: string;
  action?: Action;
}

export interface CardAction {
  label: string;
  action: Action;
}

export interface LineThreadBindingsConfig {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSubagentSessions?: boolean;
  spawnAcpSessions?: boolean;
}

interface LineAccountBaseConfig {
  enabled?: boolean;
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  responsePrefix?: string;
  mediaMaxMb?: number;
  webhookPath?: string;
  threadBindings?: LineThreadBindingsConfig;
  groups?: Record<string, LineGroupConfig>;
}

export interface LineConfig extends LineAccountBaseConfig {
  accounts?: Record<string, LineAccountBaseConfig>;
  defaultAccount?: string;
}

export interface LineGroupConfig {
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  requireMention?: boolean;
  systemPrompt?: string;
  skills?: string[];
}

export interface ResolvedLineAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  channelAccessToken: string;
  channelSecret: string;
  tokenSource: "config" | "env" | "file" | "none";
  config: LineConfig & LineAccountBaseConfig;
}

export type LineProbeResult = BaseProbeResult<string> & {
  bot?: {
    displayName?: string;
    userId?: string;
    basicId?: string;
    pictureUrl?: string;
  };
};

export type LineChannelData = {
  quickReplies?: string[];
  location?: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  };
  flexMessage?: {
    altText: string;
    contents: unknown;
  };
  templateMessage?: unknown;
};
