import type { JsonObject, JsonValue } from "./protocol-json.js";

export type CodexMcpServerStatus = {
  name: string;
  tools: JsonObject;
  resources?: JsonValue[];
  resourceTemplates?: JsonValue[];
};

export type CodexListMcpServerStatusResponse = {
  data: CodexMcpServerStatus[];
  nextCursor?: string | null;
};

export type ResourceReadParams = {
  threadId?: string | null;
  server: string;
  uri: string;
};

export type ToolCallParams = {
  threadId: string;
  server: string;
  tool: string;
  arguments?: JsonValue;
  _meta?: JsonValue;
};

export type ResourceReadResult = { contents: JsonValue[] };

export type ToolCallResult = {
  content: JsonValue[];
  structuredContent?: JsonValue;
  isError?: boolean;
  _meta?: JsonValue;
};
