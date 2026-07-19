// Codex plugin module implements protocol behavior.
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type CodexServiceTier = string;
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    }
  | "never";
type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexPersonality = "none" | "friendly" | "pragmatic";

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
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

export type CodexUserInput =
  | {
      type: "text";
      text: string;
      text_elements: Array<{
        byteRange: { start: number; end: number };
        placeholder: string | null;
      }>;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

export type CodexDynamicToolFunctionSpec = JsonObject & {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

type CodexDynamicToolNamespaceTool = CodexDynamicToolFunctionSpec;

/** Namespace Codex keeps directly model-visible without exposing it to Code Mode guests. */
export const CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE = "openclaw_direct";

type CodexDynamicToolNamespaceSpec = JsonObject & {
  type: "namespace";
  name: string;
  description: string;
  tools: CodexDynamicToolNamespaceTool[];
};

export type CodexDynamicToolSpec = CodexDynamicToolFunctionSpec | CodexDynamicToolNamespaceSpec;

export function flattenCodexDynamicToolFunctions(
  tools: readonly CodexDynamicToolSpec[] | undefined,
): CodexDynamicToolFunctionSpec[] {
  return (tools ?? []).flatMap((tool) => (tool.type === "namespace" ? tool.tools : [tool]));
}

export type CodexTurnEnvironmentParams = JsonObject & {
  environmentId: string;
  cwd: string;
};

export type CodexThreadStartParams = JsonObject & {
  input?: CodexUserInput[];
  cwd?: string;
  model?: string;
  modelProvider?: string | null;
  config?: JsonObject;
  personality?: CodexPersonality | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandbox?: CodexSandboxMode | null;
  serviceTier?: CodexServiceTier | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
  developerInstructions?: string;
  experimentalRawEvents?: boolean;
  environments?: CodexTurnEnvironmentParams[] | null;
};

export type CodexThreadResumeParams = JsonObject & {
  threadId: string;
  model?: string;
  modelProvider?: string | null;
  personality?: CodexPersonality | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandbox?: CodexSandboxMode | null;
  serviceTier?: CodexServiceTier | null;
  config?: JsonObject;
  developerInstructions?: string;
  excludeTurns?: boolean;
  initialTurnsPage?: {
    limit?: number | null;
    sortDirection?: "asc" | "desc" | null;
    itemsView?: "notLoaded" | "summary" | "full" | null;
  } | null;
};

export type CodexThreadStartResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
};

export type CodexThreadForkParams = JsonObject & {
  threadId: string;
  lastTurnId?: string | null;
  beforeTurnId?: string | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: CodexServiceTier | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandbox?: CodexSandboxMode | null;
  permissions?: string | null;
  config?: JsonObject | null;
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  threadSource?: string | null;
  excludeTurns?: boolean;
};

export type CodexThreadForkResponse = CodexThreadStartResponse;

export const CODEX_INTERACTIVE_THREAD_SOURCE_KINDS = ["cli", "vscode"] as const;
export const CODEX_INTERACTIVE_CUSTOM_THREAD_SOURCES = ["atlas", "chatgpt"] as const;

type CodexThreadSourceKind =
  | (typeof CODEX_INTERACTIVE_THREAD_SOURCE_KINDS)[number]
  | "exec"
  | "appServer"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther"
  | "unknown";

export type CodexThreadListParams = JsonObject & {
  cursor?: string | null;
  limit?: number | null;
  modelProviders?: string[] | null;
  sortKey?: "created_at" | "updated_at" | "recency_at" | null;
  sortDirection?: "asc" | "desc" | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
  sourceKinds?: CodexThreadSourceKind[] | null;
  parentThreadId?: string | null;
  ancestorThreadId?: string | null;
};

export type CodexThreadListResponse = {
  data: CodexThread[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

type CodexThreadReadParams = JsonObject & {
  threadId: string;
  includeTurns?: boolean;
};

type CodexThreadReadResponse = {
  thread: CodexThread;
};

export type CodexThreadTurnsListParams = JsonObject & {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | null;
  itemsView?: "notLoaded" | "summary" | "full" | null;
};

export type CodexThreadTurnsListResponse = {
  data: CodexTurn[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

type CodexInitialTurnsPage = Omit<CodexThreadTurnsListResponse, "data"> & {
  data: Pick<CodexTurn, "id" | "status">[];
};

type CodexThreadSetNameParams = JsonObject & {
  threadId: string;
  name: string;
};

type CodexThreadArchiveParams = JsonObject & {
  threadId: string;
};

type CodexThreadUnarchiveResponse = {
  thread: CodexThread;
};

export type CodexThreadResumeResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
  initialTurnsPage?: CodexInitialTurnsPage | null;
};

type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

type CodexThreadGoalSetParams = JsonObject & {
  threadId: string;
  objective?: string;
  status?: CodexThreadGoalStatus;
  tokenBudget?: number | null;
};

type CodexThreadGoalGetParams = JsonObject & { threadId: string };
type CodexThreadGoalClearParams = JsonObject & { threadId: string };
type CodexThreadGoalSetResponse = { goal: CodexThreadGoal };
type CodexThreadGoalGetResponse = { goal: CodexThreadGoal | null };
type CodexThreadGoalClearResponse = { cleared: boolean };

type CodexThreadInjectItemsParams = JsonObject & {
  threadId: string;
  items: JsonValue[];
};

type CodexThreadUnsubscribeParams = JsonObject & {
  threadId: string;
};

type CodexTurnInterruptParams = JsonObject & {
  threadId: string;
  turnId: string;
};

export type CodexTurnStartParams = JsonObject & {
  threadId: string;
  input: CodexUserInput[];
  cwd?: string;
  model?: string;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandboxPolicy?: CodexSandboxPolicy;
  serviceTier?: CodexServiceTier | null;
  effort?: string | null;
  personality?: CodexPersonality | null;
  environments?: CodexTurnEnvironmentParams[] | null;
  collaborationMode?: {
    mode: "plan" | "default";
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string | null;
    };
  } | null;
};

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: "restricted" | "enabled" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type CodexTurnStartResponse = {
  turn: CodexTurn;
};

export type CodexTurn = {
  id: string;
  threadId?: string;
  status?: string;
  error?: CodexErrorNotification["error"] | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items: CodexThreadItem[];
};

export type CodexThread = {
  id: string;
  sessionId?: string;
  historyMode?: "legacy" | "paginated";
  extra?: JsonObject | null;
  name?: string | null;
  preview?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  status?: CodexThreadStatus | null;
  modelProvider?: string | null;
  cwd?: string | null;
  source?: CodexSessionSource | null;
  threadSource?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  turns?: CodexTurn[];
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

type CodexSubAgentSource =
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
  asyncStarted?: boolean;
  contentItems: CodexDynamicToolCallOutputContentItem[];
  diagnosticTerminalReason?: CodexDynamicToolDiagnosticTerminalReason;
  diagnosticTerminalType?: CodexDynamicToolDiagnosticTerminalType;
  sideEffectEvidence?: boolean;
  success: boolean;
  terminate?: boolean;
};

export type CodexDynamicToolDiagnosticTerminalType = "blocked" | "completed" | "error";
export type CodexDynamicToolDiagnosticTerminalReason = "failed" | "cancelled" | "timed_out";

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

// Mirrors v2 ErrorNotification/TurnError (codex-rs app-server-protocol
// notification.rs + thread_data.rs). `message` is required upstream; other
// TurnError fields stay open because CodexErrorInfo is a wide enum.
export type CodexErrorNotification = {
  error: {
    message?: string;
    codexErrorInfo?: string | JsonObject | null;
    additionalDetails?: string | null;
    [key: string]: unknown;
  };
  willRetry?: boolean;
  threadId?: string;
  turnId?: string;
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

type CodexModelProviderCapabilitiesReadResponse = {
  namespaceTools: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
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

type CodexPluginSummary = {
  id: string;
  remotePluginId?: string;
  name: string;
  source?: JsonObject;
  installed: boolean;
  enabled: boolean;
  installPolicy?: string;
  authPolicy?: string;
  availability?: string;
  interface?: JsonValue;
};

type CodexAppSummary = {
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

type CodexPluginMarketplaceEntry = {
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

type CodexPluginListMarketplaceKind =
  | "local"
  | "vertical"
  | "workspace-directory"
  | "shared-with-me"
  | "created-by-me-remote";

type CodexPluginListParams = {
  cwds?: string[];
  marketplaceKinds?: CodexPluginListMarketplaceKind[];
};

type CodexPluginReadParams = {
  marketplacePath?: string;
  remoteMarketplaceName?: string;
  pluginName: string;
};

type CodexPluginInstallParams = CodexPluginReadParams;

type CodexPluginInstallResponse = {
  authPolicy: string;
  appsNeedingAuth: CodexAppSummary[];
};

type CodexAppInfo = {
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

type CodexAppsListParams = {
  cursor?: string | null;
  limit?: number;
  forceRefetch?: boolean;
};

type CodexAppsListResponse = {
  data: CodexAppInfo[];
  nextCursor?: string | null;
};

type CodexSkillsListParams = {
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

type CodexSkillsListResponse = {
  data: CodexSkillsListEntry[];
};

type CodexHooksListParams = {
  cwds: string[];
};

type CodexHooksListResponse = {
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

export type CodexConfigReadResponse = {
  config: JsonObject;
  layers?: JsonValue[] | null;
};

export type CodexConfigRequirementsReadResponse = {
  requirements: JsonObject | null;
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
  "environment/add": { environmentId: string; execServerUrl: string };
  "thread/fork": CodexThreadForkParams;
  "thread/archive": CodexThreadArchiveParams;
  "thread/inject_items": CodexThreadInjectItemsParams;
  "thread/list": CodexThreadListParams;
  "thread/turns/list": CodexThreadTurnsListParams;
  "thread/name/set": CodexThreadSetNameParams;
  "thread/read": CodexThreadReadParams;
  "thread/start": CodexThreadStartParams;
  "thread/unarchive": CodexThreadArchiveParams;
  "thread/unsubscribe": CodexThreadUnsubscribeParams;
  "thread/goal/set": CodexThreadGoalSetParams;
  "thread/goal/get": CodexThreadGoalGetParams;
  "thread/goal/clear": CodexThreadGoalClearParams;
  "turn/interrupt": CodexTurnInterruptParams;
};

type CodexAppServerRequestResultMap = {
  initialize: CodexInitializeResponse;
  "account/rateLimits/read": JsonValue;
  "account/read": CodexGetAccountResponse;
  "app/list": CodexAppsListResponse;
  "config/mcpServer/reload": JsonValue;
  "config/read": CodexConfigReadResponse;
  "configRequirements/read": CodexConfigRequirementsReadResponse;
  "config/value/write": JsonValue;
  "environment/add": JsonValue;
  "experimentalFeature/enablement/set": JsonValue;
  "feedback/upload": JsonValue;
  "hooks/list": CodexHooksListResponse;
  "marketplace/add": JsonValue;
  "mcpServerStatus/list": CodexListMcpServerStatusResponse;
  "model/list": CodexModelListResponse;
  "modelProvider/capabilities/read": CodexModelProviderCapabilitiesReadResponse;
  "plugin/install": CodexPluginInstallResponse;
  "plugin/list": CodexPluginListResponse;
  "plugin/read": CodexPluginReadResponse;
  "review/start": JsonValue;
  "skills/list": CodexSkillsListResponse;
  "thread/compact/start": JsonValue;
  "thread/archive": JsonValue;
  "thread/fork": CodexThreadForkResponse;
  "thread/inject_items": JsonValue;
  "thread/list": CodexThreadListResponse;
  "thread/turns/list": CodexThreadTurnsListResponse;
  "thread/name/set": JsonValue;
  "thread/read": CodexThreadReadResponse;
  "thread/resume": CodexThreadResumeResponse;
  "thread/start": CodexThreadStartResponse;
  "thread/unarchive": CodexThreadUnarchiveResponse;
  "thread/unsubscribe": JsonValue;
  "thread/goal/set": CodexThreadGoalSetResponse;
  "thread/goal/get": CodexThreadGoalGetResponse;
  "thread/goal/clear": CodexThreadGoalClearResponse;
  "turn/interrupt": JsonValue;
  "turn/start": CodexTurnStartResponse;
  "turn/steer": JsonValue;
};

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}
