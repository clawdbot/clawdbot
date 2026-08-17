import {
  prepareHarnessNativeMcpAppPreview,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import { createCodexNativeMcpRuntime } from "./native-mcp-runtime.js";
import type { CodexThreadItem, JsonValue } from "./protocol.js";

type NativeMcpCallToolResult = {
  content: JsonValue[];
  structuredContent?: JsonValue;
  isError?: boolean;
  _meta?: JsonValue;
};

function readMcpAppResourceUri(item: CodexThreadItem): string | undefined {
  const appContext = asOptionalRecord(item.appContext);
  const uri =
    normalizeOptionalString(appContext?.resourceUri) ??
    normalizeOptionalString(item.mcpAppResourceUri);
  return uri?.startsWith("ui://") ? uri : undefined;
}

function readMcpToolResult(item: CodexThreadItem): NativeMcpCallToolResult | undefined {
  const result = asOptionalRecord(item.result);
  if (!result || !Array.isArray(result.content)) {
    return undefined;
  }
  const resultMeta = asOptionalRecord(result["_meta"]);
  return {
    content: result.content as JsonValue[],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent as JsonValue }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
    // Codex serializes absent MCP result metadata as null. The MCP SDK accepts
    // only an object when `_meta` is present, so forwarding null makes Apps
    // discard the complete tool-result notification during schema validation.
    ...(resultMeta ? { _meta: resultMeta as JsonValue } : {}),
  };
}

export function createCodexNativeMcpAppResultDetailsPreparer(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
}): ((item: CodexThreadItem) => Promise<unknown>) | undefined {
  if (params.attempt.config?.mcp?.apps?.enabled !== true) {
    return undefined;
  }
  const runtime = createCodexNativeMcpRuntime(params);
  return async (item) => {
    const serverName = normalizeOptionalString(item.server);
    const toolName = normalizeOptionalString(item.tool);
    const uiResourceUri = readMcpAppResourceUri(item);
    const toolResult = readMcpToolResult(item);
    if (!serverName || !toolName || !uiResourceUri || !toolResult) {
      return undefined;
    }
    const allowedAppToolNames = new Set(
      (await runtime.getCatalog()).tools
        .filter((tool) => tool.serverName === serverName)
        .map((tool) => tool.toolName),
    );
    if (allowedAppToolNames.size === 0) {
      return undefined;
    }
    return await prepareHarnessNativeMcpAppPreview({
      runtime,
      serverName,
      toolName,
      uiResourceUri,
      toolCallId: item.id,
      toolInput: item.arguments ?? {},
      toolResult: toolResult as never,
      allowedAppToolNames,
      ...(toolResult["_meta"] !== undefined ? { resultMetaState: "unavailable" as const } : {}),
    });
  };
}
