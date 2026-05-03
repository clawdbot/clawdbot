import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type AnyAgentTool,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveMediaBufferPath } from "openclaw/plugin-sdk/media-store";
import { appendFileTransferAudit } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import {
  humanSize,
  readBoolean,
  readGatewayCallOptions,
  readTrimmedString,
} from "../shared/params.js";
import {
  FILE_TRANSFER_SUBDIR,
  FILE_WRITE_HARD_MAX_BYTES,
  FILE_WRITE_TOOL_DESCRIPTOR,
} from "./descriptors.js";

async function readSourceBytes(input: {
  contentBase64?: string;
  sourceMediaId?: string;
}): Promise<{ buffer: Buffer; contentBase64: string; source: "inline" | "media" }> {
  const sourceMediaId = input.sourceMediaId?.trim();
  if (sourceMediaId) {
    const mediaPath = await resolveMediaBufferPath(sourceMediaId, FILE_TRANSFER_SUBDIR);
    const stat = await fs.stat(mediaPath);
    if (stat.size > FILE_WRITE_HARD_MAX_BYTES) {
      throw new Error(
        `sourceMediaId too large: ${stat.size} bytes; maximum is ${FILE_WRITE_HARD_MAX_BYTES} bytes`,
      );
    }
    const buffer = await fs.readFile(mediaPath);
    return { buffer, contentBase64: buffer.toString("base64"), source: "media" };
  }
  if (input.contentBase64 === undefined) {
    throw new Error("contentBase64 or sourceMediaId required");
  }
  const buffer = Buffer.from(input.contentBase64, "base64");
  return { buffer, contentBase64: input.contentBase64, source: "inline" };
}

type FileWriteSuccess = {
  ok: true;
  path: string;
  size: number;
  sha256: string;
  overwritten: boolean;
};

type FileWriteError = {
  ok: false;
  code: string;
  message: string;
  canonicalPath?: string;
};

type FileWritePayload = FileWriteSuccess | FileWriteError;

export function createFileWriteTool(): AnyAgentTool {
  return {
    ...FILE_WRITE_TOOL_DESCRIPTOR,
    async execute(_toolCallId, params) {
      const raw: Record<string, unknown> =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};

      const nodeQuery = readTrimmedString(raw, "node");
      const filePath = readTrimmedString(raw, "path");
      const contentBase64 = typeof raw.contentBase64 === "string" ? raw.contentBase64 : undefined;
      const sourceMediaId = typeof raw.sourceMediaId === "string" ? raw.sourceMediaId : undefined;
      const overwrite = readBoolean(raw, "overwrite", false);
      const createParents = readBoolean(raw, "createParents", false);

      if (!nodeQuery) {
        throw new Error("node required");
      }
      if (!filePath) {
        throw new Error("path required");
      }
      // Compute the sha256 of the bytes we're sending so the node can do
      // an end-to-end integrity check after writing. This is always
      // sender-side computed; ignore any caller-supplied expectedSha256
      // to avoid the model passing a wrong hash and triggering an
      // unintended unlink.
      const sourceBytes = await readSourceBytes({ contentBase64, sourceMediaId });
      const buffer = sourceBytes.buffer;
      const expectedSha256 = crypto.createHash("sha256").update(buffer).digest("hex");

      const gatewayOpts = readGatewayCallOptions(raw);
      const nodes: NodeListNode[] = await listNodes(gatewayOpts);
      const nodeId = resolveNodeIdFromList(nodes, nodeQuery, false);
      const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
      const nodeDisplayName = nodeMeta?.displayName ?? nodeQuery;
      const startedAt = Date.now();

      const result = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
        nodeId,
        command: "file.write",
        params: {
          path: filePath,
          contentBase64: sourceBytes.contentBase64,
          overwrite,
          createParents,
          expectedSha256,
        },
        idempotencyKey: crypto.randomUUID(),
      });

      const payload = (result as { payload?: unknown })?.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        await appendFileTransferAudit({
          op: "file.write",
          nodeId,
          nodeDisplayName,
          requestedPath: filePath,
          decision: "error",
          errorMessage: "unexpected response from node",
          sizeBytes: buffer.byteLength,
          durationMs: Date.now() - startedAt,
        });
        throw new Error("unexpected file.write response from node");
      }

      const typed = payload as FileWritePayload;
      if (!typed.ok) {
        await appendFileTransferAudit({
          op: "file.write",
          nodeId,
          nodeDisplayName,
          requestedPath: filePath,
          canonicalPath: typed.canonicalPath,
          decision: "error",
          errorCode: typed.code,
          errorMessage: typed.message,
          sizeBytes: buffer.byteLength,
          durationMs: Date.now() - startedAt,
        });
        throwFromNodePayload("file.write", typed as unknown as Record<string, unknown>);
      }

      await appendFileTransferAudit({
        op: "file.write",
        nodeId,
        nodeDisplayName,
        requestedPath: filePath,
        canonicalPath: typed.path,
        decision: "allowed",
        sizeBytes: typed.size,
        sha256: typed.sha256,
        durationMs: Date.now() - startedAt,
      });

      const overwriteNote = typed.overwritten ? " (overwrote existing file)" : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${typed.path} (${humanSize(typed.size)}, sha256:${typed.sha256.slice(0, 12)})${overwriteNote}`,
          },
        ],
        details: { ...typed, source: sourceBytes.source },
      };
    },
  };
}
