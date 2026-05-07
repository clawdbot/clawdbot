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
  approvalPolicy?: string;
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

export type CodexThreadResumeResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
};

export type CodexTurnStartParams = JsonObject & {
  threadId: string;
  input?: CodexUserInput[];
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
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
  name?: string | null;
  cwd?: string | null;
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
  id?: string;
  name?: string;
  installed: boolean;
  enabled: boolean;
};

export type CodexPluginDetail = {
  summary: CodexPluginSummary;
  marketplaceName?: string;
  marketplacePath?: string | null;
};

export type CodexPluginMarketplaceEntry = {
  name: string;
  path?: string | null;
  plugins: CodexPluginSummary[];
};

export type CodexPluginListResponse = {
  marketplaces: CodexPluginMarketplaceEntry[];
};

export type CodexPluginReadResponse = {
  plugin: CodexPluginDetail;
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

type CodexAppServerRequestParamsOverride = {
  "thread/start": CodexThreadStartParams;
};

type CodexAppServerRequestResultMap = {
  initialize: CodexInitializeResponse;
  "account/rateLimits/read": JsonValue;
  "account/read": CodexGetAccountResponse;
  "feedback/upload": JsonValue;
  "mcpServerStatus/list": CodexListMcpServerStatusResponse;
  "model/list": CodexModelListResponse;
  "review/start": JsonValue;
  "skills/list": JsonValue;
  "thread/compact/start": JsonValue;
  "thread/list": JsonValue;
  "thread/resume": CodexThreadResumeResponse;
  "thread/start": CodexThreadStartResponse;
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
