export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type CodexServiceTier = "fast" | "flex";

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

export type CodexInitializeResponse = {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

export type CodexUserInput =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

export type CodexDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

export type CodexThreadStartParams = {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  approvalsReviewer?: "user" | "guardian_subagent";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  serviceTier?: CodexServiceTier | null;
  config?: JsonObject | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
};

export type CodexThreadResumeParams = {
  threadId: string;
  model?: string | null;
  modelProvider?: string | null;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  approvalsReviewer?: "user" | "guardian_subagent";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  serviceTier?: CodexServiceTier | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  persistExtendedHistory?: boolean;
};

export type CodexThreadStartResponse = {
  thread: CodexThread;
  model?: string | null;
  modelProvider?: string | null;
};

export type CodexThreadResumeResponse = CodexThreadStartResponse;

export type CodexTurnStartParams = {
  threadId: string;
  input: CodexUserInput[];
  cwd?: string | null;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  approvalsReviewer?: "user" | "guardian_subagent";
  model?: string | null;
  serviceTier?: CodexServiceTier | null;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
};

export type CodexTurnSteerParams = {
  threadId: string;
  expectedTurnId: string;
  input: CodexUserInput[];
};

export type CodexTurnInterruptParams = {
  threadId: string;
  turnId: string;
};

export type CodexTurnStartResponse = {
  turn: CodexTurn;
};

export type CodexThread = {
  id: string;
  status?: string;
  cwd?: string | null;
  turns?: CodexTurn[];
};

export type CodexTurn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: {
    message?: string;
  } | null;
  items?: CodexThreadItem[];
};

export type CodexThreadItem =
  | {
      type: "agentMessage";
      id: string;
      text?: string;
    }
  | {
      type: "reasoning";
      id: string;
      summary?: string[];
      content?: string[];
    }
  | {
      type: "plan";
      id: string;
      text?: string;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool?: string;
      status?: string;
    }
  | {
      type: string;
      id: string;
      status?: string;
      [key: string]: JsonValue | undefined;
    };

export type CodexServerNotification = {
  method: string;
  params?: JsonValue;
};

export type CodexDynamicToolCallParams = {
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
    };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}

export function coerceJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}
