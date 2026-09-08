import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import {
  assignMcpCatalogSafeServerNames,
  type McpToolCatalog,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexMcpServerStatus } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";

const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;
type AgentHarnessMcpCatalogParams = Parameters<NonNullable<AgentHarness["loadMcpToolCatalog"]>>[0];

function catalogTool(params: {
  serverName: string;
  safeServerName: string;
  toolName: string;
  raw?: unknown;
  deniedBySession?: true;
}): McpToolCatalog["tools"][number] {
  const raw = asOptionalRecord(params.raw);
  const description = normalizeOptionalString(raw?.description);
  const title = normalizeOptionalString(raw?.title);
  return {
    serverName: params.serverName,
    safeServerName: params.safeServerName,
    toolName: params.toolName,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    inputSchema: (asOptionalRecord(raw?.inputSchema) ?? { type: "object" }) as never,
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

/** Loads the requested MCP inventory from the exact client/thread already selected for a run. */
async function loadCodexEffectiveMcpCatalogFromThread(params: {
  client: Pick<CodexAppServerClient, "request">;
  threadId: string;
  mcpServerNames: readonly string[];
  toolOverrides?: AgentHarnessMcpCatalogParams["toolOverrides"];
}): Promise<McpToolCatalog> {
  const allowedServerNames = new Set(params.mcpServerNames);
  const statuses = (await listCodexMcpServerStatuses(params.client, params.threadId)).filter(
    (status) => allowedServerNames.has(status.name),
  );
  return buildCodexEffectiveMcpCatalog(statuses, params.toolOverrides);
}

/** Loads MCP inventory from the bound Codex client while retaining its lease through all pages. */
export async function loadCodexEffectiveMcpCatalog(
  params: AgentHarnessMcpCatalogParams,
  options: { bindingStore: CodexAppServerBindingStore },
): Promise<McpToolCatalog | undefined> {
  const binding = options.bindingStore.read(
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
    return await loadCodexEffectiveMcpCatalogFromThread({
      client: retained.client,
      threadId: binding.threadId,
      mcpServerNames: params.mcpServerNames,
      toolOverrides: params.toolOverrides,
    });
  } finally {
    retained.release();
  }
}
