import { type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { appendFileTransferAudit } from "../shared/audit.js";
import { readClampedInt } from "../shared/params.js";
import {
  DIR_LIST_DEFAULT_MAX_ENTRIES,
  DIR_LIST_HARD_MAX_ENTRIES,
  DIR_LIST_TOOL_DESCRIPTOR,
} from "./descriptors.js";
import { invokeNodeToolPayload, readRequiredNodePath } from "./node-tool-invoke.js";

export function createDirListTool(): AnyAgentTool {
  return {
    ...DIR_LIST_TOOL_DESCRIPTOR,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const { node, requestedPath: dirPath } = readRequiredNodePath(params);

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

      const { nodeId, nodeDisplayName, payload, startedAt } = await invokeNodeToolPayload({
        node,
        params,
        command: "dir.list",
        commandParams: {
          path: dirPath,
          pageToken,
          maxEntries,
        },
        requestedPath: dirPath,
      });

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
