import type {
  ClientRequest as GeneratedClientRequest,
  InitializeParams as GeneratedInitializeParams,
  InitializeResponse as GeneratedInitializeResponse,
  ServiceTier as GeneratedServiceTier,
  v2,
} from "./protocol-generated/typescript/index.js";
import type { JsonValue as GeneratedJsonValue } from "./protocol-generated/typescript/serde_json/JsonValue.js";

export type JsonValue = GeneratedJsonValue;
export type JsonObject = { [key: string]: JsonValue };
export type CodexServiceTier = GeneratedServiceTier;

export type CodexAppServerRequestMethod = GeneratedClientRequest["method"];
export type CodexAppServerRequestParams<M extends CodexAppServerRequestMethod> =
  M extends keyof CodexAppServerRequestParamsOverride
    ? CodexAppServerRequestParamsOverride[M]
    : Extract<GeneratedClientRequest, { method: M }>["params"];

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

export type CodexInitializeParams = GeneratedInitializeParams;

export type CodexInitializeResponse = GeneratedInitializeResponse;

export type CodexUserInput = v2.UserInput;

export type CodexDynamicToolSpec = v2.DynamicToolSpec;

export type CodexThreadStartParams = v2.ThreadStartParams & {
  dynamicTools?: CodexDynamicToolSpec[] | null;
};

export type CodexThreadResumeParams = v2.ThreadResumeParams;

export type CodexThreadStartResponse = v2.ThreadStartResponse;

export type CodexThreadResumeResponse = v2.ThreadResumeResponse;

export type CodexTurnStartParams = v2.TurnStartParams;

export type CodexSandboxPolicy = v2.SandboxPolicy;

export type CodexTurnStartResponse = v2.TurnStartResponse;

export type CodexTurn = v2.Turn;

export type CodexThreadItem = v2.ThreadItem;

export type CodexServerNotification = {
  method: string;
  params?: JsonValue;
};

export type CodexDynamicToolCallParams = v2.DynamicToolCallParams;

export type CodexDynamicToolCallResponse = v2.DynamicToolCallResponse;

export type CodexDynamicToolCallOutputContentItem = v2.DynamicToolCallOutputContentItem;

type CodexAppServerRequestParamsOverride = {
  "thread/start": CodexThreadStartParams;
};

type CodexAppServerRequestResultMap = {
  initialize: CodexInitializeResponse;
  "account/rateLimits/read": v2.GetAccountRateLimitsResponse;
  "account/read": v2.GetAccountResponse;
  "feedback/upload": v2.FeedbackUploadResponse;
  "mcpServerStatus/list": v2.ListMcpServerStatusResponse;
  "model/list": v2.ModelListResponse;
  "review/start": v2.ReviewStartResponse;
  "skills/list": v2.SkillsListResponse;
  "thread/compact/start": v2.ThreadCompactStartResponse;
  "thread/list": v2.ThreadListResponse;
  "thread/resume": CodexThreadResumeResponse;
  "thread/start": CodexThreadStartResponse;
  "turn/interrupt": v2.TurnInterruptResponse;
  "turn/start": CodexTurnStartResponse;
  "turn/steer": v2.TurnSteerResponse;
};

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}
