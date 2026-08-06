// Read-only agent workspace browsing for operator clients (mobile apps, UI).
// Deliberately no write/delete/upload surface: mutations need their own
// reviewed contract; see the allowlisted agents.files.* API for edits.
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import {
  ErrorCodes,
  errorShape,
  type AgentsWorkspaceEntry,
  validateAgentsWorkspaceGetParams,
  validateAgentsWorkspaceListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";
import {
  decodeUtf8Strict,
  listWorkspacePath,
  normalizeRelativePath,
  readWorkspaceFile,
  resolveWorkspacePath,
  sortWorkspaceEntries,
  statWorkspacePath,
  toUpdatedAtMs,
  WORKSPACE_PREVIEW_MAX_BYTES,
  workspaceStatKind,
} from "./workspace-fs.js";

// Images bypass the text preview cap but stay far below the 25MB WS payload
// limit even after base64 expansion (see server-constants MAX_PAYLOAD_BYTES).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 250;
const MAX_LIST_LIMIT = 500;

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function workspaceError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

function resolveWorkspaceScopeOrRespond(
  params: { agentId: string; path?: string },
  cfg: OpenClawConfig,
  respond: RespondFn,
): { agentId: string; workspaceDir: string; browserPath: string } | null {
  const agentId = normalizeAgentId(params.agentId);
  if (!new Set(listAgentIds(cfg)).has(agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const rawPath = params.path ?? "";
  const portablePath = rawPath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(portablePath) || path.win32.isAbsolute(rawPath)) {
    respond(
      false,
      undefined,
      workspaceError("workspace_path_invalid", "path must be workspace-relative", {
        path: rawPath,
      }),
    );
    return null;
  }
  const browserPath = normalizeRelativePath(params.path);
  if (!resolveWorkspacePath(workspaceDir, browserPath || ".")) {
    respond(
      false,
      undefined,
      workspaceError("workspace_path_invalid", "path escapes the agent workspace", {
        path: params.path ?? "",
      }),
    );
    return null;
  }
  return { agentId, workspaceDir, browserPath };
}

/** Gateway handlers for read-only agent workspace browsing. */
export const agentsWorkspaceHandlers: GatewayRequestHandlers = {
  "agents.workspace.list": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateAgentsWorkspaceListParams,
        "agents.workspace.list",
        respond,
      )
    ) {
      return;
    }
    const scope = resolveWorkspaceScopeOrRespond(params, context.getRuntimeConfig(), respond);
    if (!scope) {
      return;
    }
    const { agentId, workspaceDir, browserPath } = scope;
    const stat = await statWorkspacePath(workspaceDir, browserPath);
    const dirents =
      stat && workspaceStatKind(stat) === "directory"
        ? await listWorkspacePath(workspaceDir, browserPath)
        : undefined;
    if (!dirents) {
      respond(
        false,
        undefined,
        workspaceError("workspace_path_not_found", "workspace directory not found", {
          path: browserPath,
        }),
      );
      return;
    }
    const entries = sortWorkspaceEntries(
      dirents.flatMap((dirent): AgentsWorkspaceEntry[] => {
        const statKind = workspaceStatKind(dirent);
        const kind = statKind === "directory" ? "directory" : statKind === "file" ? "file" : null;
        if (!kind) {
          return [];
        }
        return [
          {
            path: browserPath ? `${browserPath}/${dirent.name}` : dirent.name,
            name: dirent.name,
            kind,
            ...(kind === "file" ? { size: dirent.size } : {}),
            updatedAtMs: toUpdatedAtMs(dirent.mtimeMs),
          },
        ];
      }),
    );
    const offset = Math.min(params.offset ?? 0, entries.length);
    const limit = Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const parent = path.dirname(browserPath);
    respond(true, {
      agentId,
      path: browserPath,
      ...(browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
      entries: entries.slice(offset, offset + limit),
      totalEntries: entries.length,
      offset,
    });
  },
  "agents.workspace.get": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateAgentsWorkspaceGetParams, "agents.workspace.get", respond)
    ) {
      return;
    }
    const scope = resolveWorkspaceScopeOrRespond(params, context.getRuntimeConfig(), respond);
    if (!scope) {
      return;
    }
    const { agentId, workspaceDir, browserPath } = scope;
    const respondNotFound = () => {
      respond(
        false,
        undefined,
        workspaceError("workspace_file_not_found", "workspace file not found", {
          path: browserPath,
        }),
      );
    };
    if (!browserPath) {
      respondNotFound();
      return;
    }
    const stat = await statWorkspacePath(workspaceDir, browserPath);
    if (!stat || workspaceStatKind(stat) !== "file") {
      respondNotFound();
      return;
    }
    const expectsImage = IMAGE_EXTENSIONS.has(path.extname(browserPath).toLowerCase());
    const maxBytes = expectsImage ? MAX_IMAGE_BYTES : WORKSPACE_PREVIEW_MAX_BYTES;
    const read =
      stat.size > maxBytes
        ? "too-large"
        : await readWorkspaceFile(workspaceDir, browserPath, { maxBytes });
    if (read === "too-large") {
      respond(
        false,
        undefined,
        workspaceError("workspace_file_too_large", "workspace file is too large to preview", {
          maxBytes,
          path: browserPath,
          size: stat.size,
        }),
      );
      return;
    }
    if (!read) {
      respondNotFound();
      return;
    }
    const respondUnsupported = () => {
      respond(
        false,
        undefined,
        workspaceError(
          "workspace_file_unsupported",
          "workspace file is not UTF-8 text or a supported image",
          { path: browserPath },
        ),
      );
    };
    // The extension only picks the byte cap; content decides what leaves the
    // gateway. Magic-byte sniffing (no filename hints) keeps renamed binaries
    // from riding the image path past the UTF-8 text gate.
    if (expectsImage) {
      const sniffedMime = await detectMime({ buffer: read.buffer });
      if (!sniffedMime || !SUPPORTED_IMAGE_MIME_TYPES.has(sniffedMime)) {
        respondUnsupported();
        return;
      }
      respond(true, {
        agentId,
        file: {
          path: browserPath,
          name: path.basename(browserPath),
          size: read.stat.size,
          updatedAtMs: toUpdatedAtMs(read.stat.mtimeMs),
          mimeType: sniffedMime,
          encoding: "base64" as const,
          content: read.buffer.toString("base64"),
        },
      });
      return;
    }
    const text = decodeUtf8Strict(read.buffer);
    if (text === undefined) {
      respondUnsupported();
      return;
    }
    respond(true, {
      agentId,
      file: {
        path: browserPath,
        name: path.basename(browserPath),
        size: read.stat.size,
        updatedAtMs: toUpdatedAtMs(read.stat.mtimeMs),
        mimeType: "text/plain",
        encoding: "utf8" as const,
        content: text,
      },
    });
  },
};
