// File Transfer plugin module implements descriptors behavior.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type FileTransferToolDescriptor = Pick<
  AnyAgentTool,
  "label" | "name" | "description" | "parameters"
>;

// Keep fetched files in the managed tool-media namespace so sandboxed replies
// can attach them and follow-up file_write calls can reuse the media id.
export const FILE_TRANSFER_SUBDIR = "tool-file-transfer";

export const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const DIR_LIST_DEFAULT_MAX_ENTRIES = 200;
export const DIR_LIST_HARD_MAX_ENTRIES = 5000;
export const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_WRITE_HARD_MAX_BYTES = 16 * 1024 * 1024;

const PAIRED_NODE_DESCRIPTION =
  "Existing paired node id, display name, or IP shown by nodes status. Do not use local, host, gateway, or auto; use local file/exec tools for local workspace paths.";

const FileFetchToolSchema = Type.Object({
  node: Type.String({
    description: PAIRED_NODE_DESCRIPTION,
  }),
  path: Type.String({
    description: "Absolute path to the file on the node. Canonicalized server-side.",
  }),
  maxBytes: optionalPositiveIntegerSchema({
    description: "Max bytes to fetch. Default 8 MB, hard ceiling 16 MB (single round-trip).",
  }),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: optionalPositiveIntegerSchema(),
});

export const FILE_FETCH_TOOL_DESCRIPTOR: FileTransferToolDescriptor = {
  label: "File Fetch",
  name: "file_fetch",
  description:
    "Retrieve a file from a paired node by absolute path. Saves all fetched bytes in the gateway's file-transfer media store and returns localPath and mediaId. Returns supported images as image content blocks and inlines small text files (≤8 KB). Use this for screenshots, photos, receipts, logs, source files. The mediaId can be reused as sourceMediaId for binary copies when node-write capability is available. Requires operator opt-in: gateway.nodes.commands.allow must include 'file.fetch', and file-transfer policy must authorize the path through allowReadPaths or a remembered exact approval. Without policy configured, every call is denied.",
  parameters: FileFetchToolSchema,
};

const DirListToolSchema = Type.Object({
  node: Type.String({
    description: PAIRED_NODE_DESCRIPTION,
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
  maxEntries: optionalPositiveIntegerSchema({
    description: `Max entries per page. Default ${DIR_LIST_DEFAULT_MAX_ENTRIES}, hard ceiling ${DIR_LIST_HARD_MAX_ENTRIES}.`,
  }),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: optionalPositiveIntegerSchema(),
});

export const DIR_LIST_TOOL_DESCRIPTOR: FileTransferToolDescriptor = {
  label: "Directory List",
  name: "dir_list",
  description:
    "Retrieve a directory listing from a paired node, not the local workspace. Text is limited to 8192 UTF-8 bytes and shows complete names, isDir and sizes under the canonical path when representable; full returned metadata stays in structured details. Use this to discover remote paths before requesting file content. For text pagination, pass the text's nextPageToken as pageToken with the same node and path; it resumes after the last displayed entry and may differ from the structured token. An unrepresentable first entry reports that pagination cannot advance. Requires operator opt-in: gateway.nodes.commands.allow must include 'dir.list', and file-transfer policy must authorize the path through allowReadPaths or a remembered exact approval. Without policy configured, every call is denied.",
  parameters: DirListToolSchema,
};

const DirFetchToolSchema = Type.Object({
  node: Type.String({
    description: PAIRED_NODE_DESCRIPTION,
  }),
  path: Type.String({
    description: "Absolute path to the directory on the node to fetch. Canonicalized server-side.",
  }),
  maxBytes: optionalPositiveIntegerSchema({
    description:
      "Max gzipped tarball bytes to fetch. Default 8 MB, hard ceiling 16 MB (single round-trip).",
  }),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: optionalPositiveIntegerSchema(),
});

export const DIR_FETCH_TOOL_DESCRIPTOR: FileTransferToolDescriptor = {
  label: "Directory Fetch",
  name: "dir_fetch",
  description:
    "Retrieve a whole directory tree, including dotfiles, from a paired node as a gzipped tarball. Unpack it on the gateway. Text is limited to 8192 UTF-8 bytes and shows rootDir, total fileCount and a prefix of complete saved relPath and size records when representable; full files and media metadata stay in structured details. Use rootDir plus relPath for local follow-up operations. Omitted files remain saved under rootDir; inspect them with available local file or directory capabilities. There is no fetch pagination. A denied descendant rejects the whole transfer. Rejects trees larger than 16 MB compressed. Requires operator opt-in: gateway.nodes.commands.allow must include 'dir.fetch', and file-transfer policy must authorize the path through allowReadPaths or a remembered exact approval.",
  parameters: DirFetchToolSchema,
};

const FileWriteToolSchema = Type.Object({
  node: Type.String({ description: PAIRED_NODE_DESCRIPTION }),
  path: Type.String({
    description: "Absolute path on the node to write. Canonicalized server-side.",
  }),
  contentBase64: Type.Optional(
    Type.String({
      description: "Base64-encoded bytes to write. Maximum 16 MB after decode.",
    }),
  ),
  sourceMediaId: Type.Optional(
    Type.String({
      description:
        "mediaId of a previously fetched file in the file-transfer media store. Reuses saved bytes for binary copies. Not a local path or an ID from another media store.",
    }),
  ),
  mimeType: Type.Optional(
    Type.String({
      description: "Content type hint. Not validated against the content.",
    }),
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description: "Allow overwriting an existing file. Default false.",
      default: false,
    }),
  ),
  createParents: Type.Optional(
    Type.Boolean({
      description: "Create missing parent directories (mkdir -p). Default false.",
      default: false,
    }),
  ),
});

export const FILE_WRITE_TOOL_DESCRIPTOR: FileTransferToolDescriptor = {
  label: "File Write",
  name: "file_write",
  description:
    "Write file bytes to a paired node by absolute path. Atomic write (temp + rename). Refuses to overwrite by default; pass overwrite=true to replace. Refuses to write through symlink targets unless policy explicitly allows following symlinks. Pass contentBase64 for inline bytes, or sourceMediaId for a previously fetched file's mediaId in the file-transfer media store. Requires operator opt-in: gateway.nodes.commands.allow must include 'file.write', and file-transfer policy must authorize the path through allowWritePaths or a remembered exact approval. Without policy configured, every call is denied.",
  parameters: FileWriteToolSchema,
};
