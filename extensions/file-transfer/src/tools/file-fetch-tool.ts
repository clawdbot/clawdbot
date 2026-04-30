import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type AnyAgentTool,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { Type } from "typebox";
import { appendFileTransferAudit } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import {
  IMAGE_MIME_INLINE_SET,
  TEXT_INLINE_MAX_BYTES,
  TEXT_INLINE_MIME_SET,
} from "../shared/mime.js";
import { humanSize, readGatewayCallOptions, readTrimmedString } from "../shared/params.js";

const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
// Stash fetched files in a non-TTL subdir so a follow-up tool call within
// the same agent turn can still reference them. The default "inbound"
// subdir gets cleaned every 2 minutes which has bitten us in iMessage flows.
const FILE_TRANSFER_SUBDIR = "file-transfer";

const FileFetchToolSchema = Type.Object({
  node: Type.String({
    description: "Node id, name, or IP. Resolves the same way as the nodes tool.",
  }),
  path: Type.String({
    description: "Absolute path to the file on the node. Canonicalized server-side.",
  }),
  maxBytes: Type.Optional(
    Type.Number({
      description: "Max bytes to fetch. Default 8 MB, hard ceiling 16 MB (single round-trip).",
    }),
  ),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

export function createFileFetchTool(): AnyAgentTool {
  return {
    label: "File Fetch",
    name: "file_fetch",
    description:
      "Retrieve a file from a paired node by absolute path. Returns image content blocks for image MIME types, inlines small text files (≤8 KB) as text content, and saves everything else under the gateway media store with a path you can pass to file_write or other tools. Use this for screenshots, photos, receipts, logs, source files. Pair with file_write to copy a file from one node to another (no exec/cp shell-out needed). Requires operator opt-in: gateway.nodes.allowCommands must include 'file.fetch' AND plugins.entries.file-transfer.config.nodes.<node>.allowReadPaths must match the path. Without policy configured, every call is denied.",
    parameters: FileFetchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const node = readTrimmedString(params, "node");
      const filePath = readTrimmedString(params, "path");
      if (!node) {
        throw new Error("node required");
      }
      if (!filePath) {
        throw new Error("path required");
      }
      const requestedMax =
        typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
          ? Math.floor(params.maxBytes)
          : FILE_FETCH_DEFAULT_MAX_BYTES;
      const maxBytes = Math.max(1, Math.min(requestedMax, FILE_FETCH_HARD_MAX_BYTES));

      const gatewayOpts = readGatewayCallOptions(params);
      const nodes: NodeListNode[] = await listNodes(gatewayOpts);
      const nodeId = resolveNodeIdFromList(nodes, node, false);
      const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
      const nodeDisplayName = nodeMeta?.displayName ?? node;
      const startedAt = Date.now();

      const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
        nodeId,
        command: "file.fetch",
        params: {
          path: filePath,
          maxBytes,
        },
        idempotencyKey: crypto.randomUUID(),
      });

      const payload =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>)
          : null;
      if (!payload) {
        await appendFileTransferAudit({
          op: "file.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: filePath,
          decision: "error",
          errorMessage: "invalid payload",
          durationMs: Date.now() - startedAt,
        });
        throw new Error("invalid file.fetch payload");
      }
      if (payload.ok === false) {
        await appendFileTransferAudit({
          op: "file.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: filePath,
          canonicalPath:
            typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
          decision: "error",
          errorCode: typeof payload.code === "string" ? payload.code : undefined,
          errorMessage: typeof payload.message === "string" ? payload.message : undefined,
          durationMs: Date.now() - startedAt,
        });
        throwFromNodePayload("file.fetch", payload);
      }

      // Type-checks, NOT truthy-checks: an empty file legitimately has
      // size=0 and base64="". Rejecting falsy values would block zero-byte
      // round-trips through file_fetch → file_write.
      const canonicalPath = typeof payload.path === "string" ? payload.path : "";
      const size = typeof payload.size === "number" ? payload.size : -1;
      const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
      const hasBase64 = typeof payload.base64 === "string";
      const base64 = hasBase64 ? (payload.base64 as string) : "";
      const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : "";
      if (!canonicalPath || size < 0 || !mimeType || !hasBase64 || !sha256) {
        throw new Error("invalid file.fetch payload (missing fields)");
      }

      const buffer = Buffer.from(base64, "base64");
      if (buffer.byteLength !== size) {
        throw new Error(
          `file.fetch size mismatch: payload says ${size} bytes, decoded ${buffer.byteLength}`,
        );
      }
      const localSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      if (localSha256 !== sha256) {
        throw new Error("file.fetch sha256 mismatch (integrity failure)");
      }

      const saved = await saveMediaBuffer(
        buffer,
        mimeType,
        FILE_TRANSFER_SUBDIR,
        FILE_FETCH_HARD_MAX_BYTES,
      );
      const localPath = saved.path;

      const isInlineImage = IMAGE_MIME_INLINE_SET.has(mimeType);
      const isInlineText = TEXT_INLINE_MIME_SET.has(mimeType) && size <= TEXT_INLINE_MAX_BYTES;

      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [];
      if (isInlineImage) {
        content.push({ type: "image", data: base64, mimeType });
      } else if (isInlineText) {
        const text = buffer.toString("utf-8");
        content.push({
          type: "text",
          text: `Fetched ${canonicalPath} (${humanSize(size)}, ${mimeType}, sha256:${sha256.slice(0, 12)}) saved at ${localPath}\n\n--- contents ---\n${text}`,
        });
      } else {
        const shortHash = sha256.slice(0, 12);
        content.push({
          type: "text",
          text: `Fetched ${canonicalPath} (${humanSize(size)}, ${mimeType}, sha256:${shortHash}) saved at ${localPath}`,
        });
      }

      await appendFileTransferAudit({
        op: "file.fetch",
        nodeId,
        nodeDisplayName,
        requestedPath: filePath,
        canonicalPath,
        decision: "allowed",
        sizeBytes: size,
        sha256,
        durationMs: Date.now() - startedAt,
      });

      return {
        content,
        details: {
          path: canonicalPath,
          size,
          mimeType,
          sha256,
          localPath,
          mediaId: saved.id,
          media: {
            mediaUrls: [localPath],
          },
        },
      };
    },
  };
}
