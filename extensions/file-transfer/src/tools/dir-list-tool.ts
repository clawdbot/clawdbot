import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type AnyAgentTool,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { Type } from "typebox";
import { appendFileTransferAudit } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import { readClampedInt, readGatewayCallOptions, readTrimmedString } from "../shared/params.js";

const DIR_LIST_DEFAULT_MAX_ENTRIES = 200;
const DIR_LIST_HARD_MAX_ENTRIES = 5000;

const DirListToolSchema = Type.Object({
  node: Type.String({
    description: "Node id, name, or IP. Resolves the same way as the nodes tool.",
  }),
  path: Type.String({
    description: "Absolute path to the directory on the node. Canonicalized server-side.",
  }),
  pageToken: Type.Optional(
    Type.String({
      description:
        "Pagination token from a previous dir_list call. Omit to start from the beginning.",
    }),
  ),
  maxEntries: Type.Optional(
    Type.Number({
      description: `Max entries per page. Default ${DIR_LIST_DEFAULT_MAX_ENTRIES}, hard ceiling ${DIR_LIST_HARD_MAX_ENTRIES}.`,
    }),
  ),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

export function createDirListTool(): AnyAgentTool {
  return {
    label: "Directory List",
    name: "dir_list",
    description:
      "Retrieve a structured directory listing from a paired node. Returns file and subdirectory metadata (name, path, size, mimeType, isDir, mtime) without transferring file content. Use this to discover what files exist before fetching them with file_fetch. Pagination is offset-based; pass nextPageToken from the previous result. Requires operator opt-in: gateway.nodes.allowCommands must include 'dir.list' AND plugins.entries.file-transfer.config.nodes.<node>.allowReadPaths must match the directory path. Without policy configured, every call is denied.",
    parameters: DirListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const node = readTrimmedString(params, "node");
      const dirPath = readTrimmedString(params, "path");
      if (!node) {
        throw new Error("node required");
      }
      if (!dirPath) {
        throw new Error("path required");
      }

      const maxEntries = readClampedInt({
        input: params,
        key: "maxEntries",
        defaultValue: DIR_LIST_DEFAULT_MAX_ENTRIES,
        hardMin: 1,
        hardMax: DIR_LIST_HARD_MAX_ENTRIES,
      });

      const pageToken =
        typeof params.pageToken === "string" && params.pageToken.trim()
          ? params.pageToken.trim()
          : undefined;

      const gatewayOpts = readGatewayCallOptions(params);
      const nodes: NodeListNode[] = await listNodes(gatewayOpts);
      const nodeId = resolveNodeIdFromList(nodes, node, false);
      const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
      const nodeDisplayName = nodeMeta?.displayName ?? node;
      const startedAt = Date.now();

      const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
        nodeId,
        command: "dir.list",
        params: {
          path: dirPath,
          pageToken,
          maxEntries,
        },
        idempotencyKey: crypto.randomUUID(),
      });

      const payload =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>)
          : null;
      if (!payload) {
        await appendFileTransferAudit({
          op: "dir.list",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          decision: "error",
          errorMessage: "invalid payload",
          durationMs: Date.now() - startedAt,
        });
        throw new Error("invalid dir.list payload");
      }
      if (payload.ok === false) {
        await appendFileTransferAudit({
          op: "dir.list",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          canonicalPath:
            typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
          decision: "error",
          errorCode: typeof payload.code === "string" ? payload.code : undefined,
          errorMessage: typeof payload.message === "string" ? payload.message : undefined,
          durationMs: Date.now() - startedAt,
        });
        throwFromNodePayload("dir.list", payload);
      }

      const canonicalPath = typeof payload.path === "string" ? payload.path : dirPath;

      const entries = Array.isArray(payload.entries)
        ? (payload.entries as Array<Record<string, unknown>>)
        : [];
      const truncated = payload.truncated === true;
      const nextPageToken =
        typeof payload.nextPageToken === "string" ? payload.nextPageToken : undefined;

      const fileCount = entries.filter((e) => !e.isDir).length;
      const dirCount = entries.filter((e) => e.isDir).length;
      const truncatedNote = truncated ? " (more entries available — pass nextPageToken)" : "";
      const summary = `Listed ${canonicalPath}: ${fileCount} file${fileCount !== 1 ? "s" : ""}, ${dirCount} subdir${dirCount !== 1 ? "s" : ""}${truncatedNote}`;

      await appendFileTransferAudit({
        op: "dir.list",
        nodeId,
        nodeDisplayName,
        requestedPath: dirPath,
        canonicalPath,
        decision: "allowed",
        durationMs: Date.now() - startedAt,
      });

      return {
        content: [{ type: "text" as const, text: summary }],
        details: {
          path: canonicalPath,
          entries,
          nextPageToken,
          truncated,
        },
      };
    },
  };
}
