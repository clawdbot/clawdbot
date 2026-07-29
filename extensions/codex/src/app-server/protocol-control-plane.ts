import type { JsonObject, JsonValue } from "./protocol-json.js";

/** Current Codex marketplace, app, skill, hook, and config wire contracts. */
export type CodexPluginSummary = {
  id: string;
  remotePluginId?: string | null;
  name: string;
  source?: JsonObject;
  installed: boolean;
  enabled: boolean;
  installPolicy?: string;
  authPolicy?: string;
  availability?: string;
  interface?: JsonValue;
};

export type CodexAppSummary = {
  id: string;
  name: string;
  description: string | null;
  installUrl: string | null;
  category: string | null;
};

export type CodexPluginDetail = {
  marketplaceName?: string;
  marketplacePath?: string | null;
  summary: CodexPluginSummary;
  description?: string | null;
  skills?: JsonValue[];
  apps: CodexAppSummary[];
  mcpServers: string[];
};

export type CodexPluginMarketplaceEntry = {
  name: string;
  path?: string | null;
  interface?: JsonValue;
  plugins: CodexPluginSummary[];
};

type CodexMarketplaceLoadErrorInfo = {
  marketplacePath: string;
  message: string;
};

export type CodexPluginInstalledParams = {
  cwds?: string[] | null;
  installSuggestionPluginNames?: string[] | null;
};

export type CodexPluginInstalledResponse = {
  marketplaces: CodexPluginMarketplaceEntry[];
  marketplaceLoadErrors: CodexMarketplaceLoadErrorInfo[];
};

export type CodexPluginListResponse = {
  marketplaces: CodexPluginMarketplaceEntry[];
  marketplaceLoadErrors: CodexMarketplaceLoadErrorInfo[];
  featuredPluginIds: string[];
};

export type CodexPluginReadResponse = {
  plugin: CodexPluginDetail;
};

type CodexPluginListMarketplaceKind =
  | "local"
  | "vertical"
  | "workspace-directory"
  | "shared-with-me"
  | "created-by-me-remote";

export type CodexPluginListParams = {
  cwds?: string[] | null;
  forceRefetch?: boolean;
  marketplaceKinds?: CodexPluginListMarketplaceKind[] | null;
};

export type CodexPluginReadParams = {
  marketplacePath?: string | null;
  remoteMarketplaceName?: string | null;
  pluginName: string;
};

export type CodexPluginInstallParams = CodexPluginReadParams;

export type CodexPluginInstallResponse = {
  authPolicy: string;
  appsNeedingAuth: CodexAppSummary[];
};

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
  labels?: Record<string, string | undefined> | null;
  installUrl?: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  pluginDisplayNames: string[];
};

export type CodexAppsListParams = {
  cursor?: string | null;
  limit?: number | null;
  threadId?: string | null;
  forceRefetch?: boolean;
};

export type CodexAppsListResponse = {
  data: CodexAppInfo[];
  nextCursor?: string | null;
};

export type CodexInstalledApp = {
  id: string;
  runtimeName: string | null;
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

type CodexAppToolSummary = {
  name: string;
  title: string | null;
  description: string;
  isEnabled: boolean;
  disabledReason: string | null;
  isReadOnly: boolean;
};

type CodexConnectorMetadata = {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  iconUrlDark: string | null;
  distributionChannel: string | null;
  installUrl: string | null;
  pluginDisplayNames: string[];
  toolSummaries: CodexAppToolSummary[] | null;
};

export type CodexAppsReadParams = {
  appIds: string[];
  includeTools?: boolean;
};

export type CodexAppsReadResponse = {
  apps: CodexConnectorMetadata[];
  missingAppIds: string[];
};

export type CodexSkillsListParams = {
  cwds: string[];
  forceReload?: boolean;
};

type CodexSkillScope = "user" | "repo" | "system" | "admin";

type CodexSkillMetadata = {
  name: string;
  description: string;
  shortDescription?: string;
  interface?: JsonObject;
  dependencies?: JsonObject;
  path: string;
  scope: CodexSkillScope;
  enabled: boolean;
};

type CodexSkillErrorInfo = {
  path: string;
  message: string;
};

type CodexSkillsListEntry = {
  cwd: string;
  skills: CodexSkillMetadata[];
  errors: CodexSkillErrorInfo[];
};

export type CodexSkillsListResponse = {
  data: CodexSkillsListEntry[];
};

export type CodexHooksListParams = {
  cwds: string[];
};

export type CodexHooksListResponse = {
  data: JsonValue[];
  nextCursor?: string | null;
};

export type CodexConfigReadResponse = {
  config: JsonObject;
  layers?: JsonValue[] | null;
};

type CodexConfigMergeStrategy = "replace" | "upsert";

export type CodexConfigEdit = {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: CodexConfigMergeStrategy;
};

export type CodexConfigValueWriteParams = CodexConfigEdit & {
  filePath?: string | null;
  expectedVersion?: string | null;
};

export type CodexConfigBatchWriteParams = {
  edits: CodexConfigEdit[];
  filePath?: string | null;
  expectedVersion?: string | null;
  reloadUserConfig?: boolean;
};

type CodexConfigLayerSource =
  | { type: "mdm"; domain: string; key: string }
  | { type: "system"; file: string }
  | { type: "enterpriseManaged"; id: string; name: string }
  | { type: "user"; file: string; profile: string | null }
  | { type: "project"; dotCodexFolder: string }
  | { type: "sessionFlags" }
  | { type: "legacyManagedConfigTomlFromFile"; file: string }
  | { type: "legacyManagedConfigTomlFromMdm" };

type CodexConfigLayerMetadata = {
  name: CodexConfigLayerSource;
  version: string;
};

// Codex permits optional response object entries; outbound JSON stays strict.
type CodexWireJsonValue =
  | null
  | boolean
  | number
  | string
  | CodexWireJsonValue[]
  | { [key in string]?: CodexWireJsonValue };

type CodexConfigOverriddenMetadata = {
  message: string;
  overridingLayer: CodexConfigLayerMetadata;
  effectiveValue: CodexWireJsonValue;
};

type CodexConfigWriteStatus = "ok" | "okOverridden";

export type CodexConfigWriteResponse = {
  status: CodexConfigWriteStatus;
  version: string;
  filePath: string;
  overriddenMetadata: CodexConfigOverriddenMetadata | null;
};

export type CodexConfigRequirementsReadResponse = {
  requirements: JsonObject | null;
};
