// File Transfer plugin module implements dir list tool behavior.
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { appendFileTransferAudit } from "../shared/audit.js";
import { readClampedInt } from "../shared/params.js";
import {
  DIR_LIST_DEFAULT_MAX_ENTRIES,
  DIR_LIST_HARD_MAX_ENTRIES,
  DIR_LIST_TOOL_DESCRIPTOR,
} from "./descriptors.js";
import { invokeNodeToolPayload, readRequiredNodePath } from "./node-tool-invoke.js";

const DIRECTORY_TEXT_MAX_BYTES = 8192;

function directoryListingText(
  canonicalPath: string,
  entries: Array<Record<string, unknown>>,
  pageToken: string | undefined,
  nextPageToken: string | undefined,
  truncated: boolean,
): string {
  const offset = parseStrictNonNegativeInteger(pageToken) ?? 0;
  const visible: Array<{ name: unknown; isDir: unknown; size: unknown }> = [];
  const render = () => {
    const limited = visible.length < entries.length;
    const continuation = limited
      ? visible.length > 0
        ? String(offset + visible.length)
        : undefined
      : nextPageToken;
    const listing = JSON.stringify({
      path: canonicalPath,
      returnedCount: entries.length,
      displayedCount: visible.length,
      entries: visible,
      truncated: limited || truncated,
      nextPageToken: continuation,
    });
    const note =
      limited && visible.length === 0
        ? "No entries displayed: the next complete entry or directory metadata exceeds the text budget or contains reserved markers. Pagination cannot advance; use available node-local directory capabilities."
        : (limited || truncated) && !continuation
          ? "More entries available; the node supplied no continuation token."
          : "If present, pass nextPageToken as pageToken; keep node and path.";
    const wrapped = wrapExternalContent(`${listing}\n${note}`, { source: "unknown" });
    // Sanitization may rewrite marker-like filenames. Never offer those rewritten
    // paths, and count the complete wrapper before accepting a whole-record prefix.
    return wrapped.includes(listing) &&
      Buffer.byteLength(wrapped, "utf8") <= DIRECTORY_TEXT_MAX_BYTES
      ? wrapped
      : undefined;
  };
  let text = render();
  // Keep normal continuation guidance the same size on the last page so a
  // longer intermediate footer cannot prevent a complete page from fitting.
  for (const { name, isDir, size } of entries) {
    visible.push({ name, isDir, size });
    const candidate = render();
    if (!candidate) {
      break;
    }
    text = candidate;
  }
  return (
    text ??
    wrapExternalContent(
      "Directory listing omitted: the canonical path or continuation metadata cannot be represented safely within the 8192-byte text limit. No usable paths or continuation token are shown; use available node-local directory capabilities.",
      { source: "unknown" },
    )
  );
}

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
        content: [
          {
            type: "text" as const,
            text: directoryListingText(canonicalPath, entries, pageToken, nextPageToken, truncated),
          },
        ],
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
