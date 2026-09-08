import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  MAX_ACTION_CATALOG_PAGES,
  NODE_INVOKE_TIMEOUT_MS,
  unwrapNodeInvokePayload,
  parseCatalogPage,
} from "./session-catalog-parsing.js";
import type { CodexSessionCatalogSession } from "./session-catalog-types.js";

export async function lookupNodeCodexCatalogRecord(params: {
  agentId: string;
  runtime: PluginRuntime;
  nodeId: string;
  threadId: string;
}): Promise<
  { kind: "found"; record: CodexSessionCatalogSession } | { kind: "missing" | "cursor-cycle" }
> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < MAX_ACTION_CATALOG_PAGES; pageIndex += 1) {
    const raw = await params.runtime.nodes.invoke({
      nodeId: params.nodeId,
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      params: {
        agentId: params.agentId,
        limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      },
      timeoutMs: NODE_INVOKE_TIMEOUT_MS,
      scopes: ["operator.write"],
    });
    const page = parseCatalogPage(unwrapNodeInvokePayload(raw));
    const record = page.sessions.find((candidate) => candidate.threadId === params.threadId);
    if (record) {
      return { kind: "found", record };
    }
    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor) {
      break;
    }
    if (seenCursors.has(nextCursor)) {
      return { kind: "cursor-cycle" };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { kind: "missing" };
}
