import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import {
  assignMcpCatalogSafeServerNames,
  type McpToolCatalog,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexMcpServerStatus } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";

const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;
const READY_MCP_AUTH_STATUSES = new Set(["unsupported", "bearerToken", "oAuth"]);
type AgentHarnessMcpCatalogParams = Parameters<NonNullable<AgentHarness["loadMcpToolCatalog"]>>[0];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function catalogTool(params: {
  serverName: string;
  safeServerName: string;
  toolName: string;
  raw?: unknown;
  deniedBySession?: true;
}): McpToolCatalog["tools"][number] {
  const raw = asRecord(params.raw);
  const description = readString(raw?.description);
  return {
    serverName: params.serverName,
    safeServerName: params.safeServerName,
    toolName: params.toolName,
    ...(readString(raw?.title) ? { title: readString(raw?.title) } : {}),
    ...(description ? { description } : {}),
    inputSchema: (asRecord(raw?.inputSchema) ?? { type: "object" }) as never,
    fallbackDescription: description ?? params.toolName,
    ...(params.deniedBySession ? { deniedBySession: true } : {}),
  };
}

/** Converts Codex's thread-scoped status response into OpenClaw's MCP catalog shape. */
function buildCodexEffectiveMcpCatalog(
  statuses: readonly CodexMcpServerStatus[],
  toolOverrides?: AgentHarnessMcpCatalogParams["toolOverrides"],
): McpToolCatalog {
  const statusByName = new Map(statuses.map((status) => [status.name, status] as const));
  const orderedStatuses = [...statusByName.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const safeNames = assignMcpCatalogSafeServerNames(orderedStatuses.map((status) => status.name));
  const serverEntries: Array<[string, McpToolCatalog["servers"][string]]> = [];
  const tools: McpToolCatalog["tools"] = [];
  const sessionDeniedTools: NonNullable<McpToolCatalog["sessionDeniedTools"]> = [];

  for (const status of orderedStatuses) {
    const safeServerName = safeNames.get(status.name) ?? status.name;
    const denialMap = toolOverrides?.mcpToolsDeny;
    const deniedNames = new Set(
      denialMap && Object.hasOwn(denialMap, status.name) ? denialMap[status.name] : [],
    );
    const observedNames = new Set<string>();
    for (const [toolName, raw] of Object.entries(status.tools).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      observedNames.add(toolName);
      const deniedBySession = deniedNames.has(toolName) ? true : undefined;
      const tool = catalogTool({
        serverName: status.name,
        safeServerName,
        toolName,
        raw,
        ...(deniedBySession ? { deniedBySession } : {}),
      });
      if (deniedBySession) {
        sessionDeniedTools.push(tool);
      } else {
        tools.push(tool);
      }
    }
    for (const toolName of [...deniedNames].toSorted()) {
      if (observedNames.has(toolName)) {
        continue;
      }
      sessionDeniedTools.push(
        catalogTool({
          serverName: status.name,
          safeServerName,
          toolName,
          deniedBySession: true,
        }),
      );
    }
    serverEntries.push([
      status.name,
      {
        serverName: status.name,
        safeServerName,
        launchSummary: "Codex native MCP connection",
        toolCount:
          observedNames.size + [...deniedNames].filter((name) => !observedNames.has(name)).length,
      },
    ]);
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    servers: Object.fromEntries(serverEntries),
    tools,
    ...(sessionDeniedTools.length > 0 ? { sessionDeniedTools } : {}),
  };
}

async function listCodexMcpServerStatuses(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
): Promise<CodexMcpServerStatus[]> {
  const statuses: CodexMcpServerStatus[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
    const response = await client.request("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
      limit: MCP_STATUS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    statuses.push(...response.data);
    cursor = response.nextCursor;
    if (!cursor) {
      return statuses;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Codex mcpServerStatus/list repeated its pagination cursor");
    }
    seenCursors.add(cursor);
  }
  throw new Error("Codex mcpServerStatus/list exceeded the bounded page limit");
}

function assertInitializedMcpInventory(
  statuses: readonly CodexMcpServerStatus[],
  intendedServerNames: readonly string[],
): void {
  const statusByName = new Map(statuses.map((status) => [status.name, status] as const));
  const incomplete = intendedServerNames.flatMap((serverName) => {
    const status = statusByName.get(serverName);
    if (!status) {
      return [`${serverName} (not reported)`];
    }
    if (!readString(status.serverInfo?.name) || !readString(status.serverInfo?.version)) {
      return [`${serverName} (initialization incomplete)`];
    }
    if (!status.authStatus || !READY_MCP_AUTH_STATUSES.has(status.authStatus)) {
      return [
        `${serverName} (${status.authStatus === "notLoggedIn" ? "authentication required" : "authentication status unavailable"})`,
      ];
    }
    return [];
  });
  if (incomplete.length > 0) {
    throw new Error(
      `Codex configured MCP inventory is incomplete: ${incomplete.join(", ")}. ` +
        "Retry after the servers initialize and authenticate.",
    );
  }
}

/** Loads the requested MCP inventory from the exact client/thread already selected for a run. */
export async function loadCodexEffectiveMcpCatalogFromThread(params: {
  client: Pick<CodexAppServerClient, "request">;
  threadId: string;
  mcpServerNames: readonly string[];
  toolOverrides?: AgentHarnessMcpCatalogParams["toolOverrides"];
  /** Creator-cap capture requires a complete initialized inventory, including zero-tool servers. */
  requireInitializedInventory?: boolean;
}): Promise<McpToolCatalog> {
  const allowedServerNames = new Set(params.mcpServerNames);
  const statuses = (await listCodexMcpServerStatuses(params.client, params.threadId)).filter(
    (status) => allowedServerNames.has(status.name),
  );
  if (params.requireInitializedInventory) {
    assertInitializedMcpInventory(statuses, params.mcpServerNames);
  }
  return buildCodexEffectiveMcpCatalog(statuses, params.toolOverrides);
}

/** Loads MCP inventory only from the already-bound Codex process and thread. */
export async function loadCodexEffectiveMcpCatalog(
  params: AgentHarnessMcpCatalogParams,
  options: { bindingStore: CodexAppServerBindingStore },
): Promise<McpToolCatalog | undefined> {
  const binding = await options.bindingStore.read(
    sessionBindingIdentity({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      config: params.config,
    }),
  );
  if (!binding?.clientId) {
    return undefined;
  }
  const retained = retainSharedCodexAppServerClientByInstanceId(binding.clientId);
  if (!retained) {
    return undefined;
  }
  try {
    return loadCodexEffectiveMcpCatalogFromThread({
      client: retained.client,
      threadId: binding.threadId,
      mcpServerNames: params.mcpServerNames,
      toolOverrides: params.toolOverrides,
    });
  } finally {
    retained.release();
  }
}
