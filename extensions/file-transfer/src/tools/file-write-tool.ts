import crypto from "node:crypto";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { appendFileTransferAudit } from "../shared/audit.js";
import { humanSize, readBoolean } from "../shared/params.js";
import {
  FILE_TRANSFER_SUBDIR,
  FILE_WRITE_HARD_MAX_BYTES,
  FILE_WRITE_TOOL_DESCRIPTOR,
} from "./descriptors.js";
import { invokeNodeToolPayload, readRequiredNodePath } from "./node-tool-invoke.js";

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function decodeStrictBase64(value: string): Buffer {
  const buffer = Buffer.from(value, "base64");
  if (normalizeBase64ForCompare(buffer.toString("base64")) !== normalizeBase64ForCompare(value)) {
    throw new Error("contentBase64 is not valid base64");
  }
  return buffer;
}

async function readSourceBytes(input: {
  contentBase64?: string;
  sourceMediaId?: string;
}): Promise<{ buffer: Buffer; contentBase64: string; source: "inline" | "media" }> {
  const sourceMediaId = input.sourceMediaId?.trim();
  if (sourceMediaId) {
    const { buffer } = await readMediaBuffer(
      sourceMediaId,
      FILE_TRANSFER_SUBDIR,
      FILE_WRITE_HARD_MAX_BYTES,
    );
    return { buffer, contentBase64: buffer.toString("base64"), source: "media" };
  }
  if (input.contentBase64 === undefined) {
    throw new Error("contentBase64 or sourceMediaId required");
  }
  const buffer = decodeStrictBase64(input.contentBase64);
  return { buffer, contentBase64: input.contentBase64, source: "inline" };
}

type FileWriteSuccess = {
  ok: true;
  path: string;
  size: number;
  sha256: string;
  overwritten: boolean;
};

export function createFileWriteTool(): AnyAgentTool {
  return {
    ...FILE_WRITE_TOOL_DESCRIPTOR,
    async execute(_toolCallId, params) {
      const raw: Record<string, unknown> =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};

      const { node: nodeQuery, requestedPath: filePath } = readRequiredNodePath(raw);
      const contentBase64 = typeof raw.contentBase64 === "string" ? raw.contentBase64 : undefined;
      const sourceMediaId = typeof raw.sourceMediaId === "string" ? raw.sourceMediaId : undefined;
      const overwrite = readBoolean(raw, "overwrite", false);
      const createParents = readBoolean(raw, "createParents", false);

      // Compute the sha256 of the bytes we're sending so the node can do
      // an end-to-end integrity check after writing. This is always
      // sender-side computed; ignore any caller-supplied expectedSha256
      // to avoid the model passing a wrong hash and triggering an
      // unintended unlink.
      const sourceBytes = await readSourceBytes({ contentBase64, sourceMediaId });
      const buffer = sourceBytes.buffer;
      const expectedSha256 = crypto.createHash("sha256").update(buffer).digest("hex");

      const { nodeId, nodeDisplayName, payload, startedAt } = await invokeNodeToolPayload({
        node: nodeQuery,
        params: raw,
        command: "file.write",
        commandParams: {
          path: filePath,
          contentBase64: sourceBytes.contentBase64,
          overwrite,
          createParents,
          expectedSha256,
        },
        invalidPayloadMessage: "unexpected response from node",
        invalidPayloadError: "unexpected file.write response from node",
        errorAuditExtra: { sizeBytes: buffer.byteLength },
        requireOk: true,
        requestedPath: filePath,
      });

      const typed = payload as FileWriteSuccess;

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
