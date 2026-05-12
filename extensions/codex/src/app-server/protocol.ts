export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type CodexServiceTier = string;

export type CodexAppServerRequestMethod = keyof CodexAppServerRequestResultMap | (string & {});
export type CodexAppServerRequestParams<M extends CodexAppServerRequestMethod> =
  M extends keyof CodexAppServerRequestParamsOverride
    ? CodexAppServerRequestParamsOverride[M]
    : unknown;

export type CodexAppServerRequestResult<M extends CodexAppServerRequestMethod> =
  M extends keyof CodexAppServerRequestResultMap
    ? CodexAppServerRequestResultMap[M]
    : JsonValue | undefined;

export type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};

export type RpcResponse = {
  id: number | string;
  result?: JsonValue;
  error?: {
    code?: number;
    message: string;
    data?: JsonValue;
  };
};

export type RpcMessage = RpcRequest | RpcResponse;

export type CodexInitializeParams = {
  clientInfo: {
    name: string;
    title?: string;
    version?: string;
  };
  capabilities?: JsonObject;
};

export type CodexInitializeResponse = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  protocolVersion?: string;
  userAgent?: string;
};

export type CodexUserInput =
  | {
      type: "text";
      text: string;
      text_elements?: JsonValue[];
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

export type CodexDynamicToolSpec = JsonObject & {
  name: string;
  description: string;
  inputSchema: JsonValue;
};

export type CodexThreadStartParams = JsonObject & {
  input?: CodexUserInput[];
  cwd?: string;
  model?: string;
  modelProvider?: string | null;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandbox?: CodexSandboxPolicy;
  serviceTier?: CodexServiceTier | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
  developerInstructions?: string;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
};

export type CodexThreadResumeParams = JsonObject & {
  threadId: string;
  model?: string;
  modelProvider?: string | null;
};

export type CodexThreadStartResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
};

export type CodexThreadForkParams = CodexThreadStartParams & {
  threadId: string;
  baseInstructions?: string;
  ephemeral?: boolean;
  threadSource?: string | JsonObject;
  excludeTurns?: boolean;
};

export type CodexThreadForkResponse = CodexThreadStartResponse;

export type CodexThreadResumeResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
};

export type CodexThreadInjectItemsParams = JsonObject & {
  threadId: string;
  items: JsonValue[];
};

export type CodexThreadUnsubscribeParams = JsonObject & {
  threadId: string;
};

export type CodexTurnInterruptParams = JsonObject & {
  threadId: string;
  turnId: string;
};

export type CodexTurnStartParams = JsonObject & {
  threadId: string;
  input?: CodexUserInput[];
  cwd?: string;
  model?: string;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandboxPolicy?: CodexSandboxPolicy;
  serviceTier?: CodexServiceTier | null;
  effort?: string | null;
  collaborationMode?: {
    mode: string;
    settings: JsonObject & {
      developer_instructions: string | null;
    };
  } | null;
};

export type CodexSandboxPolicy = string | JsonObject;

export type CodexTurnStartResponse = {
  turn: CodexTurn;
};

export type CodexTurn = {
  id: string;
  threadId: string;
  status?: string;
  error?: CodexErrorNotification["error"];
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  items: CodexThreadItem[];
};

export type CodexThread = {
  id: string;
  sessionId?: string;
  name?: string | null;
  preview?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  status?: CodexThreadStatus | null;
  cwd?: string | null;
  source?: CodexSessionSource | null;
  threadSource?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
};

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: string[] };

export type CodexSubAgentThreadSpawnSource = {
  parent_thread_id: string;
  depth?: number;
  agent_path?: string | null;
  agent_nickname?: string | null;
  agent_role?: string | null;
};

export type CodexSubAgentSource =
  | "review"
  | "compact"
  | "memory_consolidation"
  | { thread_spawn: CodexSubAgentThreadSpawnSource }
  | { other: string };

export type CodexSessionSource =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "unknown"
  | { custom: string }
  | { subAgent: CodexSubAgentSource };

export type CodexThreadStartedNotification = {
  thread: CodexThread;
};

export type CodexThreadStatusChangedNotification = {
  threadId: string;
  status: CodexThreadStatus;
};

export type CodexThreadItem = {
  id: string;
  type: string;
  title: string | null;
  status: string | null;
  name: string | null;
  tool: string | null;
  server: string | null;
  command: string | null;
  cwd: string | null;
  query: string | null;
  arguments?: JsonValue;
  result?: JsonValue;
  error?: CodexErrorNotification["error"];
  exitCode?: number | null;
  durationMs?: number | null;
  aggregatedOutput: string | null;
  text: string;
  contentItems?: CodexDynamicToolCallOutputContentItem[] | null;
  changes: Array<{ path: string; kind: string }>;
  [key: string]: unknown;
};

export type CodexServerNotification = {
  method: string;
  params?: JsonValue;
};

export type CodexDynamicToolCallParams = {
  namespace?: string | null;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: JsonValue;
};

export type CodexDynamicToolCallResponse = {
  contentItems: CodexDynamicToolCallOutputContentItem[];
  success: boolean;
};

export type CodexDynamicToolCallOutputContentItem =
  | {
      type: "inputText";
      text: string;
    }
  | {
      type: "inputImage";
      imageUrl: string;
    }
  | JsonObject;

export type CodexErrorNotification = {
  error: {
    message?: string;
    codexErrorInfo?: {
      message?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  message?: string;
};

export type CodexTurnCompletedNotification = {
  turn: CodexTurn;
};

export type CodexModel = {
  id?: string;
  model?: string;
  displayName?: string | null;
  description?: string | null;
  hidden: boolean;
  isDefault: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
};

export type CodexReasoningEffortOption = {
  reasoningEffort?: string | null;
};

export type CodexModelListResponse = {
  data: CodexModel[];
  nextCursor?: string | null;
};

export type CodexGetAccountResponse = {
  account?: JsonValue;
  requiresOpenaiAuth?: boolean;
};

export type CodexChatgptAuthTokensRefreshResponse = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};

export type CodexLoginAccountParams =
  | {
      type: "apiKey";
      apiKey: string;
    }
  | {
      type: "chatgptAuthTokens";
      accessToken: string;
      chatgptAccountId: string;
      chatgptPlanType: string | null;
    };

export type CodexPluginSummary = {
  id: string;
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
  description?: string | null;
  installUrl?: string | null;
  needsAuth: boolean;
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

export type CodexPluginListResponse = {
  marketplaces: CodexPluginMarketplaceEntry[];
  marketplaceLoadErrors?: JsonValue[];
  featuredPluginIds?: string[];
};

export type CodexPluginReadResponse = {
  plugin: CodexPluginDetail;
};

export type CodexPluginListParams = {
  cwds: string[];
};

export type CodexPluginReadParams = {
  marketplacePath?: string;
  remoteMarketplaceName?: string;
  pluginName: string;
};

export type CodexPluginInstallParams = CodexPluginReadParams;

export type CodexPluginInstallResponse = {
  authPolicy: string;
  appsNeedingAuth: CodexAppSummary[];
};

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

export type CodexAppsListParams = {
  cursor?: string | null;
  limit?: number;
  forceRefetch?: boolean;
};

export type CodexAppsListResponse = {
  data: CodexAppInfo[];
  nextCursor?: string | null;
};

export type CodexSkillsListParams = {
  cwds: string[];
  forceReload?: boolean;
};

export type CodexSkillsListResponse = {
  data: JsonValue[];
  nextCursor?: string | null;
};

export type CodexHooksListParams = {
  cwds: string[];
};

export type CodexHooksListResponse = {
  data: JsonValue[];
  nextCursor?: string | null;
};

export type CodexMcpServerStatus = {
  name: string;
  tools: JsonObject;
};

export type CodexListMcpServerStatusResponse = {
  data: CodexMcpServerStatus[];
  nextCursor?: string | null;
};

export type CodexRequestObject = Record<string, unknown>;

export declare namespace v2 {
  export type AppInfo = CodexAppInfo;
  export type AppSummary = CodexAppSummary;
  export type AppsListParams = CodexAppsListParams;
  export type AppsListResponse = CodexAppsListResponse;
  export type HooksListParams = CodexHooksListParams;
  export type HooksListResponse = CodexHooksListResponse;
  export type PluginDetail = CodexPluginDetail;
  export type PluginInstallParams = CodexPluginInstallParams;
  export type PluginInstallResponse = CodexPluginInstallResponse;
  export type PluginListParams = CodexPluginListParams;
  export type PluginListResponse = CodexPluginListResponse;
  export type PluginMarketplaceEntry = CodexPluginMarketplaceEntry;
  export type PluginReadParams = CodexPluginReadParams;
  export type PluginReadResponse = CodexPluginReadResponse;
  export type PluginSummary = CodexPluginSummary;
  export type SkillsListParams = CodexSkillsListParams;
  export type SkillsListResponse = CodexSkillsListResponse;
}

type CodexAppServerRequestParamsOverride = {
  "thread/fork": CodexThreadForkParams;
  "thread/inject_items": CodexThreadInjectItemsParams;
  "thread/start": CodexThreadStartParams;
  "thread/unsubscribe": CodexThreadUnsubscribeParams;
  "turn/interrupt": CodexTurnInterruptParams;
};

type CodexAppServerRequestResultMap = {
  initialize: CodexInitializeResponse;
  "account/rateLimits/read": JsonValue;
  "account/read": CodexGetAccountResponse;
  "app/list": CodexAppsListResponse;
  "config/mcpServer/reload": JsonValue;
  "experimentalFeature/enablement/set": JsonValue;
  "feedback/upload": JsonValue;
  "hooks/list": CodexHooksListResponse;
  "marketplace/add": JsonValue;
  "mcpServerStatus/list": CodexListMcpServerStatusResponse;
  "model/list": CodexModelListResponse;
  "plugin/install": CodexPluginInstallResponse;
  "plugin/list": CodexPluginListResponse;
  "plugin/read": CodexPluginReadResponse;
  "review/start": JsonValue;
  "skills/list": CodexSkillsListResponse;
  "thread/compact/start": JsonValue;
  "thread/fork": CodexThreadForkResponse;
  "thread/inject_items": JsonValue;
  "thread/list": JsonValue;
  "thread/resume": CodexThreadResumeResponse;
  "thread/start": CodexThreadStartResponse;
  "thread/unsubscribe": JsonValue;
  "turn/interrupt": JsonValue;
  "turn/start": CodexTurnStartResponse;
  "turn/steer": JsonValue;
};

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}
