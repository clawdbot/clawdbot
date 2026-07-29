import type { JsonValue } from "./protocol-json.js";

/** App inventory shape consumed by OpenClaw's existing plugin policy. */
export type CodexAppInfo = {
  id: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
  distributionChannel?: string | null;
  branding?: JsonValue;
  appMetadata?: JsonValue;
  labels?: JsonValue;
  installUrl?: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  pluginDisplayNames: string[];
};

/** Legacy inventory contract retained for supported pre-0.145 app servers. */
export type CodexAppsListParams = {
  cursor?: string | null;
  limit?: number;
  forceRefetch?: boolean;
};

export type CodexAppsListResponse = {
  data: CodexAppInfo[];
  nextCursor?: string | null;
};

/** Runtime app state returned by Codex app-server `app/installed`. */
type CodexInstalledApp = {
  id: string;
  runtimeName?: string | null;
  enabled: boolean;
  callable: boolean;
};

export type CodexAppsInstalledParams = {
  threadId?: string | null;
  forceRefresh?: boolean;
};

export type CodexAppsInstalledResponse = {
  apps: CodexInstalledApp[];
};

/** Canonical connector metadata returned by Codex app-server `app/read`. */
type CodexConnectorMetadata = {
  id: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  iconUrlDark?: string | null;
  distributionChannel?: string | null;
  installUrl?: string | null;
  pluginDisplayNames: string[];
};

export type CodexAppsReadParams = {
  appIds: string[];
  includeTools?: boolean;
};

export type CodexAppsReadResponse = {
  apps: CodexConnectorMetadata[];
  missingAppIds: string[];
};
