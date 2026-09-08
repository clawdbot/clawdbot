import { type CallToolResult, ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { BoardMcpAppDescriptor } from "../../packages/gateway-protocol/src/index.js";
import {
  acquireSessionMcpRuntime,
  releaseSessionMcpRuntime,
} from "../agents/agent-bundle-mcp-manager-api.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  fetchMcpAppView,
  getMcpAppViewLease,
  type McpAppViewLease,
} from "../agents/mcp-ui-resource.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { visitSessionMessagesAsync } from "./session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const MCP_APP_RESTORE_IN_FLIGHT_KEY = Symbol.for("openclaw.mcpAppRestoreInFlight");

type McpAppDescriptor = {
  viewId: string;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId: string;
  resultMetaState?: "unavailable";
};

type TranscriptLookup = { viewId: string } | { descriptor: BoardMcpAppDescriptor };

type ReconstructionData = {
  descriptor: McpAppDescriptor;
  toolInput: unknown;
  toolResult: CallToolResult;
};

type ReconstructionResult = {
  runtime: SessionMcpRuntime;
  view: McpAppViewLease;
};

type TranscriptVisit = (visit: (message: unknown) => void) => Promise<void>;
type TranscriptResult = Omit<ReconstructionData, "toolInput"> & { modelToolName: string };
type TranscriptResultRead =
  | { kind: "restorable"; value: TranscriptResult }
  | { kind: "unavailable" };

function readDescriptor(value: unknown): McpAppDescriptor | undefined {
  const record = asOptionalRecord(value);
  const viewId = normalizeOptionalString(record?.viewId);
  const serverName = normalizeOptionalString(record?.serverName);
  const toolName = normalizeOptionalString(record?.toolName);
  const uiResourceUri = normalizeOptionalString(record?.uiResourceUri);
  const toolCallId = normalizeOptionalString(record?.toolCallId);
  const rawResultMetaState = record?.resultMetaState;
  const resultMetaState = rawResultMetaState === "unavailable" ? rawResultMetaState : undefined;
  if (
    !viewId ||
    viewId.length > 128 ||
    !serverName ||
    serverName.length > 256 ||
    !toolName ||
    toolName.length > 256 ||
    !uiResourceUri?.startsWith("ui://") ||
    uiResourceUri.length > 2048 ||
    !toolCallId ||
    toolCallId.length > 512 ||
    (rawResultMetaState !== undefined && resultMetaState === undefined)
  ) {
    return undefined;
  }
  return {
    viewId,
    serverName,
    toolName,
    uiResourceUri,
    toolCallId,
    ...(resultMetaState ? { resultMetaState } : {}),
  };
}

function readToolInputFromMessage(
  value: unknown,
  toolCallId: string,
  modelToolName: string,
): { found: true; input: unknown } | undefined {
  const message = asOptionalRecord(value);
  if (normalizeOptionalString(message?.role)?.toLowerCase() !== "assistant") {
    return undefined;
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const blockValue of content) {
    const block = asOptionalRecord(blockValue);
    if (
      (normalizeOptionalString(block?.id) ?? normalizeOptionalString(block?.toolCallId)) !==
      toolCallId
    ) {
      continue;
    }
    const type = normalizeOptionalString(block?.type)?.toLowerCase();
    if (type !== "toolcall" && type !== "tool_call" && type !== "tooluse" && type !== "tool_use") {
      continue;
    }
    const blockToolName =
      normalizeOptionalString(block?.name) ??
      normalizeOptionalString(block?.toolName) ??
      normalizeOptionalString(block?.tool_name);
    if (blockToolName !== modelToolName) {
      continue;
    }
    return { found: true, input: block?.arguments ?? block?.input ?? block?.args ?? {} };
  }
  return undefined;
}

function readCallToolResult(message: Record<string, unknown>, details: Record<string, unknown>) {
  const content = Array.isArray(message.content)
    ? message.content.flatMap((value) => {
        const parsed = ContentBlockSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    content,
    ...(details.structuredContent !== undefined
      ? { structuredContent: details.structuredContent }
      : {}),
    ...(message.isError === true || details.status === "error" ? { isError: true } : {}),
  } as CallToolResult;
}

function matchesLookup(
  rawDescriptor: Record<string, unknown> | undefined,
  lookup: TranscriptLookup,
): boolean {
  if ("viewId" in lookup) {
    return normalizeOptionalString(rawDescriptor?.viewId) === lookup.viewId;
  }
  const descriptor = lookup.descriptor;
  return (
    normalizeOptionalString(rawDescriptor?.serverName) === descriptor.serverName &&
    normalizeOptionalString(rawDescriptor?.toolName) === descriptor.toolName &&
    normalizeOptionalString(rawDescriptor?.uiResourceUri) === descriptor.uiResourceUri &&
    normalizeOptionalString(rawDescriptor?.toolCallId) === descriptor.toolCallId
  );
}

function readTranscriptResult(
  value: unknown,
  lookup: TranscriptLookup,
): TranscriptResultRead | undefined {
  const message = asOptionalRecord(value);
  if (!message || normalizeOptionalString(message.role)?.toLowerCase() !== "toolresult") {
    return undefined;
  }
  const details = asOptionalRecord(message.details);
  if (!details) {
    return undefined;
  }
  const preview = asOptionalRecord(details.mcpAppPreview);
  const rawDescriptor = asOptionalRecord(preview?.mcpApp);
  if (!matchesLookup(rawDescriptor, lookup)) {
    return undefined;
  }
  const descriptor = readDescriptor(rawDescriptor);
  const modelToolName =
    normalizeOptionalString(message.toolName) ?? normalizeOptionalString(message.tool_name);
  if (!descriptor || !modelToolName) {
    return { kind: "unavailable" };
  }
  if (
    normalizeOptionalString(message.toolCallId) !== descriptor.toolCallId ||
    normalizeOptionalString(details.mcpServer) !== descriptor.serverName ||
    normalizeOptionalString(details.mcpTool) !== descriptor.toolName ||
    descriptor.resultMetaState === "unavailable"
  ) {
    return { kind: "unavailable" };
  }
  return {
    kind: "restorable",
    value: { descriptor, modelToolName, toolResult: readCallToolResult(message, details) },
  };
}

/** Searches the full active transcript without retaining its messages in memory. */
async function findMcpAppReconstructionDataByVisit(
  visitTranscript: TranscriptVisit,
  lookup: TranscriptLookup,
): Promise<ReconstructionData | undefined> {
  let resultRead: TranscriptResultRead | undefined;
  let resultIndex = -1;
  let messageIndex = 0;
  await visitTranscript((message) => {
    const read = readTranscriptResult(message, lookup);
    if (read) {
      resultRead = read;
      resultIndex = messageIndex;
    }
    messageIndex += 1;
  });
  if (!resultRead || resultRead.kind === "unavailable") {
    return undefined;
  }
  const resolvedResult = resultRead.value;
  let toolInput: unknown;
  let foundInput = false;
  messageIndex = 0;
  await visitTranscript((message) => {
    if (messageIndex >= resultIndex) {
      messageIndex += 1;
      return;
    }
    const input = readToolInputFromMessage(
      message,
      resolvedResult.descriptor.toolCallId,
      resolvedResult.modelToolName,
    );
    if (input) {
      foundInput = true;
      toolInput = input.input;
    }
    messageIndex += 1;
  });
  if (!foundInput) {
    return undefined;
  }
  const { modelToolName: _modelToolName, ...reconstruction } = resolvedResult;
  return { ...reconstruction, toolInput };
}

function getRestoreInFlight(): Map<string, Promise<ReconstructionResult | undefined>> {
  const state = globalThis as Record<PropertyKey, unknown>;
  const existing = state[MCP_APP_RESTORE_IN_FLIGHT_KEY] as
    | Map<string, Promise<ReconstructionResult | undefined>>
    | undefined;
  if (existing) {
    return existing;
  }
  const created = new Map<string, Promise<ReconstructionResult | undefined>>();
  state[MCP_APP_RESTORE_IN_FLIGHT_KEY] = created;
  return created;
}

async function reconstructMcpAppView(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  lookup: TranscriptLookup;
  allowedAppToolNames: ReadonlySet<string>;
  authorizeAppInteraction?: () => boolean | Promise<boolean>;
  readOnly: boolean;
  viewId?: string;
}): Promise<ReconstructionResult | undefined> {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId });
  const sessionId = loaded.entry?.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const transcriptScope = {
    agentId,
    sessionId,
    sessionKey: loaded.canonicalKey,
    storePath: loaded.storePath,
    sessionEntry: loaded.entry,
  };
  const data = await findMcpAppReconstructionDataByVisit(async (visit) => {
    await visitSessionMessagesAsync(transcriptScope, visit);
  }, params.lookup);
  if (!data) {
    return undefined;
  }
  const acquisition = await acquireSessionMcpRuntime({
    sessionId,
    sessionKey: loaded.canonicalKey,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId),
    agentDir: resolveAgentDir(params.cfg, agentId),
    cfg: params.cfg,
  });
  const { runtime } = acquisition;
  try {
    if (runtime.mcpAppsEnabled !== true) {
      return undefined;
    }
    const fetched = await fetchMcpAppView({
      runtime,
      agentId,
      serverName: data.descriptor.serverName,
      toolName: data.descriptor.toolName,
      uiResourceUri: data.descriptor.uiResourceUri,
      toolCallId: data.descriptor.toolCallId,
      toolInput: data.toolInput,
      toolResult: data.toolResult,
      ...(params.viewId ? { viewId: params.viewId } : {}),
      allowedAppToolNames: params.allowedAppToolNames,
      ...(params.authorizeAppInteraction
        ? { authorizeAppInteraction: params.authorizeAppInteraction }
        : {}),
      ...(params.readOnly ? { readOnly: true as const } : {}),
    });
    const view = fetched ? getMcpAppViewLease(fetched.viewId, runtime) : undefined;
    return view ? { runtime, view } : undefined;
  } finally {
    await releaseSessionMcpRuntime(acquisition);
  }
}

async function restoreMcpAppViewOnce(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  viewId: string;
}): Promise<ReconstructionResult | undefined> {
  if (!params.viewId.startsWith("mcp-app-") || params.viewId.length > 128) {
    return undefined;
  }
  return await reconstructMcpAppView({
    ...params,
    lookup: { viewId: params.viewId },
    // A reconstructed preview can render and read its owning server resources,
    // but cannot call tools without a fresh run carrying current effective policy.
    allowedAppToolNames: new Set(),
    readOnly: true,
  });
}

export async function mintMcpAppViewFromTranscript(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  descriptor: BoardMcpAppDescriptor;
  allowedAppToolNames: ReadonlySet<string>;
  authorizeAppInteraction?: () => boolean | Promise<boolean>;
  readOnly: boolean;
}): Promise<ReconstructionResult | undefined> {
  return await reconstructMcpAppView({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    lookup: { descriptor: params.descriptor },
    allowedAppToolNames: params.allowedAppToolNames,
    ...(params.authorizeAppInteraction
      ? { authorizeAppInteraction: params.authorizeAppInteraction }
      : {}),
    readOnly: params.readOnly,
  });
}

export async function restoreMcpAppView(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  viewId: string;
}): Promise<ReconstructionResult | undefined> {
  const key = `${params.agentId ?? ""}\0${params.sessionKey}\0${params.viewId}`;
  const inFlight = getRestoreInFlight();
  return await getOrCreatePromise(inFlight, key, () => restoreMcpAppViewOnce(params), {
    evictOnSettled: true,
  });
}
