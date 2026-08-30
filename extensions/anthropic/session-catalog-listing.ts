import fs from "node:fs/promises";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import {
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import { createNodeListFailedError, resolveNodeLabel } from "./session-catalog-node-helpers.js";
import {
  decodeOffset,
  encodeOffset,
  MAX_HOSTS,
  MAX_PAGE_LIMIT,
  MAX_TRANSCRIPT_LIMIT,
  parseCatalogPage,
  parseGatewayQuery,
  readListParams,
  readNodePageCursor,
  readOptionalCursor,
  readTranscriptParams,
  unwrapNodePayload,
} from "./session-catalog-parsing.js";
import {
  configuredClaudeConfigDir,
  currentHomeDir,
  gatewayClaudeScanOptions,
} from "./session-catalog-scan.js";
import {
  CLAUDE_CLI_NODE_RUN_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  ClaudeCatalogParamsError,
} from "./session-catalog-shared.js";
import * as catalogTerminal from "./session-catalog-terminal.js";
import { parseTranscriptLine, type ClaudeTranscriptItem } from "./session-catalog-transcript.js";
import type {
  ClaudeSessionCatalogHost,
  ClaudeSessionCatalogPage,
  ClaudeSessionCatalogResult,
  ClaudeSessionCatalogSession,
  ClaudeSessionTranscriptPage,
} from "./session-catalog-types.js";

const TRANSCRIPT_READ_CHUNK_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;
const NODE_INVOKE_TIMEOUT_MS = 30_000;
// Catalog refresh is fail-soft: one unhealthy machine must not hold the whole sidebar.
// The node invoke keeps running so cold native discovery can warm the next poll.
const NODE_CATALOG_LIST_RESPONSE_TIMEOUT_MS = 20_000;
const CLAUDE_HISTORY_IMPORT_MAX_ITEMS = 200;
const CLAUDE_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;

export async function listLocalClaudeSessionPage(
  value: unknown,
  homeDir?: string,
  scanOptions?: { configDir?: string; includeDesktop?: boolean },
): Promise<ClaudeSessionCatalogPage> {
  const resolvedHome = homeDir ?? currentHomeDir();
  const resolvedScanOptions =
    scanOptions ?? (homeDir === undefined ? gatewayClaudeScanOptions(true) : {});
  const params = readListParams(value);
  const offset = decodeOffset(params.cursor, "catalog");
  const search = params.searchTerm?.toLocaleLowerCase();
  const records = (await listClaudeSessions(resolvedHome, resolvedScanOptions)).filter((record) => {
    if (!search) {
      return true;
    }
    return [record.name, record.cwd, record.gitBranch, record.threadId].some((candidate) =>
      candidate?.toLocaleLowerCase().includes(search),
    );
  });
  const page = records
    .slice(offset, offset + params.limit)
    .map(({ filePath: _filePath, ...record }) => record);
  const nextOffset = offset + page.length;
  return {
    sessions: page,
    ...(nextOffset < records.length ? { nextCursor: encodeOffset(nextOffset) } : {}),
  };
}

export async function readLocalClaudeTranscriptPage(
  value: unknown,
  homeDir?: string,
  scanOptions?: { configDir?: string; includeDesktop?: boolean },
): Promise<Omit<ClaudeSessionTranscriptPage, "hostId" | "label">> {
  const resolvedHome = homeDir ?? currentHomeDir();
  const resolvedScanOptions =
    scanOptions ?? (homeDir === undefined ? gatewayClaudeScanOptions(true) : {});
  const params = readTranscriptParams(value);
  let filePath = (await listClaudeSessions(resolvedHome, resolvedScanOptions)).find(
    (record) => record.threadId === params.threadId,
  )?.filePath;
  if (!filePath) {
    // A just-created session can race the stamp snapshot. Specific reads must retry against disk so
    // opening a new thread never fails only because the assembled catalog is still warm.
    filePath = (
      await listClaudeSessions(resolvedHome, { ...resolvedScanOptions, forceRefresh: true })
    ).find((record) => record.threadId === params.threadId)?.filePath;
  }
  if (!filePath) {
    throw new ClaudeCatalogParamsError("Claude session is unavailable");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const requestedEnd = params.cursor ? decodeOffset(params.cursor, "transcript") : stat.size;
    if (requestedEnd > stat.size) {
      throw new ClaudeCatalogParamsError("transcript cursor is invalid");
    }
    let position = requestedEnd;
    let scanned = 0;
    let fragments: Buffer[] = [];
    const found: Array<{ item: ClaudeTranscriptItem; start: number }> = [];
    while (position > 0 && scanned < MAX_TRANSCRIPT_SCAN_BYTES && found.length <= params.limit) {
      const size = Math.min(
        TRANSCRIPT_READ_CHUNK_BYTES,
        position,
        MAX_TRANSCRIPT_SCAN_BYTES - scanned,
      );
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      // Positional reads may return short, so complete the bounded window.
      // A zero-byte read before it fills means the file changed after stat.
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await handle.read(chunk, filled, size - filled, position + filled);
        if (bytesRead === 0) {
          throw new Error("Claude transcript changed while it was being read");
        }
        filled += bytesRead;
      }
      scanned += filled;
      let right = filled;
      for (let index = filled - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 0x0a) {
          continue;
        }
        const segment = chunk.subarray(index + 1, right);
        if (segment.length > 0 || fragments.length > 0) {
          const line = Buffer.concat([segment, ...fragments.toReversed()]);
          const item = parseTranscriptLine(line, readBoundedString);
          fragments = [];
          if (item) {
            item.resumeCursor = encodeOffset(position + index + 1 + line.length);
            found.push({ item, start: position + index + 1 });
            if (found.length > params.limit) {
              break;
            }
          }
        }
        right = index;
      }
      if (found.length > params.limit) {
        break;
      }
      const prefix = chunk.subarray(0, right);
      if (position === 0) {
        if (prefix.length > 0 || fragments.length > 0) {
          const line = Buffer.concat([prefix, ...fragments.toReversed()]);
          const item = parseTranscriptLine(line, readBoundedString);
          if (item) {
            item.resumeCursor = encodeOffset(line.length);
            found.push({ item, start: 0 });
          }
        }
        fragments = [];
      } else if (prefix.length > 0) {
        fragments.push(prefix);
      }
    }
    if (position > 0 && found.length < params.limit) {
      throw new Error("Claude transcript page exceeded the safe scan limit");
    }
    const requested = found.slice(0, params.limit);
    const selected: typeof requested = [];
    let selectedBytes = 0;
    for (const entry of requested) {
      const itemBytes = Buffer.byteLength(JSON.stringify(entry.item), "utf8");
      if (
        selected.length > 0 &&
        selectedBytes + itemBytes > MAX_TRANSCRIPT_PAGE_BYTES - 64 * 1024
      ) {
        break;
      }
      selected.push(entry);
      selectedBytes += itemBytes;
    }
    const earliestStart = selected.at(-1)?.start;
    const hasEarlierItems = selected.length < found.length || position > 0;
    return {
      threadId: params.threadId,
      // Match the Codex session-page contract: newest item first on the wire;
      // the shared UI prepends each page after restoring chronological order.
      items: selected.map((entry) => entry.item),
      ...(hasEarlierItems && earliestStart !== undefined && earliestStart > 0
        ? { nextCursor: encodeOffset(earliestStart) }
        : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function listClaudeSessionCatalog(params: {
  runtime: PluginRuntime;
  query?: unknown;
  allowProcessHomeFallback?: boolean;
  listNodes?: Parameters<SessionCatalogProvider["list"]>[0]["listNodes"];
  onHost?: (host: ClaudeSessionCatalogHost) => void;
}): Promise<ClaudeSessionCatalogResult> {
  const query = parseGatewayQuery(params.query);
  const requested = query.hostIds ? new Set(query.hostIds) : undefined;
  const scanOptions = gatewayClaudeScanOptions(params.allowProcessHomeFallback);
  const localHosts: Promise<ClaudeSessionCatalogHost>[] =
    (params.allowProcessHomeFallback !== false || scanOptions.configDir !== undefined) &&
    (!requested || requested.has(CLAUDE_LOCAL_SESSION_HOST_ID))
      ? [
          (async () => {
            try {
              return {
                hostId: CLAUDE_LOCAL_SESSION_HOST_ID,
                label: "Local Claude",
                kind: "gateway",
                connected: true,
                ...(await listLocalClaudeSessionPage(
                  {
                    limit: query.limitPerHost,
                    ...(query.search ? { searchTerm: query.search } : {}),
                    ...(query.cursors?.[CLAUDE_LOCAL_SESSION_HOST_ID] !== undefined
                      ? { cursor: query.cursors[CLAUDE_LOCAL_SESSION_HOST_ID] }
                      : {}),
                  },
                  currentHomeDir(),
                  scanOptions,
                )),
              };
            } catch {
              return {
                hostId: CLAUDE_LOCAL_SESSION_HOST_ID,
                label: "Local Claude",
                kind: "gateway",
                connected: true,
                sessions: [],
                error: {
                  code: "LOCAL_READ_FAILED",
                  message: "Local Claude sessions are unavailable",
                },
              };
            }
          })(),
        ]
      : [];
  for (const host of localHosts) {
    if (params.onHost) {
      void host.then(params.onHost).catch(() => undefined);
    }
  }
  const wantsNodes = !requested || query.hostIds?.some((hostId) => hostId.startsWith("node:"));
  if (!wantsNodes) {
    return { hosts: await Promise.all(localHosts) };
  }
  let nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];
  try {
    nodes = (await (params.listNodes?.() ?? params.runtime.nodes.list())).nodes;
  } catch (error) {
    const registryHost: ClaudeSessionCatalogHost = {
      hostId: "node:registry",
      label: "Paired nodes",
      kind: "node",
      connected: false,
      sessions: [],
      error: createNodeListFailedError(error),
    };
    params.onHost?.(registryHost);
    return {
      hosts: [...(await Promise.all(localHosts)), registryHost],
    };
  }
  const eligible = nodes
    .filter(
      (node) =>
        node.gatewayLocal !== true &&
        node.commands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) &&
        (!requested || requested.has(`node:${node.nodeId}`)),
    )
    .slice(0, MAX_HOSTS - localHosts.length)
    .toSorted((left, right) => resolveNodeLabel(left).localeCompare(resolveNodeLabel(right)));
  const nodeHosts = await Promise.all(
    eligible.map(async (node): Promise<ClaudeSessionCatalogHost> => {
      const hostId = `node:${node.nodeId}`;
      const common = {
        hostId,
        label: resolveNodeLabel(node),
        kind: "node" as const,
        connected: node.connected === true,
        nodeId: node.nodeId,
        canContinueClaude:
          node.commands?.includes(CLAUDE_SESSION_READ_COMMAND) === true &&
          node.commands.includes(CLAUDE_CLI_NODE_RUN_COMMAND) &&
          node.invocableCommands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) === true &&
          node.invocableCommands.includes(CLAUDE_SESSION_READ_COMMAND) &&
          node.invocableCommands.includes(CLAUDE_CLI_NODE_RUN_COMMAND),
        ...catalogTerminal.claudeNodeTerminalCapability(node),
      };
      if (node.connected !== true) {
        const host: ClaudeSessionCatalogHost = Object.assign({}, common, {
          sessions: [],
          error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
        });
        params.onHost?.(host);
        return host;
      }
      const eventualHost = Promise.resolve()
        .then(async () => {
          const raw = await params.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: CLAUDE_SESSIONS_LIST_COMMAND,
            params: {
              limit: query.limitPerHost,
              ...(query.search ? { searchTerm: query.search } : {}),
              ...(query.cursors?.[hostId] !== undefined ? { cursor: query.cursors[hostId] } : {}),
            },
            timeoutMs: NODE_INVOKE_TIMEOUT_MS,
            scopes: ["operator.write"],
          });
          return Object.assign({}, common, parseCatalogPage(unwrapNodePayload(raw)));
        })
        .catch(
          (): ClaudeSessionCatalogHost =>
            Object.assign({}, common, {
              sessions: [],
              error: {
                code: "NODE_INVOKE_FAILED",
                message: "Paired node Claude sessions are unavailable",
              },
            }),
        );
      if (params.onHost) {
        // The fail-soft response can finish first; the original node invoke still
        // publishes its authoritative host page whenever cold discovery completes.
        void eventualHost.then(params.onHost).catch(() => undefined);
      }
      try {
        return await withTimeout(eventualHost, NODE_CATALOG_LIST_RESPONSE_TIMEOUT_MS, {
          message: "paired node Claude session catalog timed out",
        });
      } catch {
        return Object.assign({}, common, {
          sessions: [],
          error: {
            code: "NODE_INVOKE_FAILED",
            message: "Paired node Claude sessions are unavailable",
          },
        });
      }
    }),
  );
  return { hosts: [...(await Promise.all(localHosts)), ...nodeHosts] };
}

export async function readClaudeSessionTranscript(params: {
  runtime: PluginRuntime;
  hostId: string;
  threadId: string;
  cursor?: string;
  limit: number;
  allowProcessHomeFallback?: boolean;
}): Promise<ClaudeSessionTranscriptPage> {
  const cursor = readOptionalCursor(params.cursor, "transcript");
  if (params.hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
    assertClaudeLocalAccess(params.hostId, params.allowProcessHomeFallback);
    return {
      hostId: params.hostId,
      label: "Local Claude",
      ...(await readLocalClaudeTranscriptPage(
        {
          threadId: params.threadId,
          limit: params.limit,
          ...(cursor !== undefined ? { cursor } : {}),
        },
        currentHomeDir(),
        gatewayClaudeScanOptions(params.allowProcessHomeFallback),
      )),
    };
  }
  if (!params.hostId.startsWith("node:")) {
    throw new ClaudeCatalogParamsError("hostId is invalid");
  }
  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(CLAUDE_SESSION_READ_COMMAND),
  );
  if (!node) {
    throw new ClaudeCatalogParamsError("paired-node Claude session host is unavailable");
  }
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: CLAUDE_SESSION_READ_COMMAND,
    params: {
      threadId: params.threadId,
      limit: params.limit,
      ...(cursor !== undefined ? { cursor } : {}),
    },
    timeoutMs: NODE_INVOKE_TIMEOUT_MS,
    scopes: ["operator.write"],
  });
  const page = unwrapNodePayload(raw);
  if (
    !isRecord(page) ||
    !Array.isArray(page.items) ||
    page.items.length > MAX_TRANSCRIPT_LIMIT ||
    page.items.some((item) => !isRecord(item) || typeof item.type !== "string") ||
    page.threadId !== params.threadId ||
    Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_TRANSCRIPT_PAGE_BYTES
  ) {
    throw new Error("Claude node returned an invalid transcript page");
  }
  const nextCursor = readNodePageCursor(page, "Claude node returned an invalid transcript page");
  return {
    hostId: params.hostId,
    label: resolveNodeLabel(node),
    threadId: params.threadId,
    items: page.items as ClaudeTranscriptItem[],
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export function assertClaudeLocalAccess(hostId: string, allowProcessHomeFallback?: boolean): void {
  if (
    hostId === CLAUDE_LOCAL_SESSION_HOST_ID &&
    allowProcessHomeFallback === false &&
    configuredClaudeConfigDir() === undefined
  ) {
    throw new ClaudeCatalogParamsError("local Claude sessions are unavailable in isolated state");
  }
}

export async function readBoundedClaudeHistory(params: {
  runtime: PluginRuntime;
  hostId: string;
  threadId: string;
  allowProcessHomeFallback?: boolean;
}): Promise<ClaudeTranscriptItem[]> {
  const items: ClaudeTranscriptItem[] = [];
  let cursor: string | undefined;
  let bytes = 0;
  while (items.length < CLAUDE_HISTORY_IMPORT_MAX_ITEMS) {
    const page = await readClaudeSessionTranscript({
      runtime: params.runtime,
      hostId: params.hostId,
      threadId: params.threadId,
      limit: Math.min(MAX_TRANSCRIPT_LIMIT, CLAUDE_HISTORY_IMPORT_MAX_ITEMS - items.length),
      allowProcessHomeFallback: params.allowProcessHomeFallback,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length > 0 && bytes + itemBytes > CLAUDE_HISTORY_IMPORT_MAX_BYTES) {
        return items;
      }
      items.push(item);
      bytes += itemBytes;
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  return items;
}

export async function resolveNodeClaudeRecord(params: {
  runtime: PluginRuntime;
  nodeId: string;
  threadId: string;
}): Promise<ClaudeSessionCatalogSession> {
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const raw = await params.runtime.nodes.invoke({
      nodeId: params.nodeId,
      command: CLAUDE_SESSIONS_LIST_COMMAND,
      params: {
        limit: MAX_PAGE_LIMIT,
        searchTerm: params.threadId,
        ...(cursor ? { cursor } : {}),
      },
      timeoutMs: NODE_INVOKE_TIMEOUT_MS,
      scopes: ["operator.write"],
    });
    const page = parseCatalogPage(unwrapNodePayload(raw));
    const record = page.sessions.find((candidate) => candidate.threadId === params.threadId);
    if (record) {
      return record;
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  throw new ClaudeCatalogParamsError("Claude session is unavailable on the paired node");
}
