import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type AnyAgentTool,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { appendFileTransferAudit } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import {
  IMAGE_MIME_INLINE_SET,
  TEXT_INLINE_MAX_BYTES,
  TEXT_INLINE_MIME_SET,
} from "../shared/mime.js";
import { humanSize, readGatewayCallOptions, readTrimmedString } from "../shared/params.js";
import {
  FILE_FETCH_DEFAULT_MAX_BYTES,
  FILE_FETCH_HARD_MAX_BYTES,
  FILE_FETCH_TOOL_DESCRIPTOR,
  FILE_TRANSFER_SUBDIR,
} from "./descriptors.js";

export function createFileFetchTool(): AnyAgentTool {
  return {
    ...FILE_FETCH_TOOL_DESCRIPTOR,
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
