import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type FileTransferToolDescriptor = Pick<
  AnyAgentTool,
  "label" | "name" | "description" | "parameters"
>;

// Stash fetched files in a non-TTL subdir so follow-up tool calls within
// the same turn can still reference them.
export const FILE_TRANSFER_SUBDIR = "file-transfer";

export const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const DIR_LIST_DEFAULT_MAX_ENTRIES = 200;
export const DIR_LIST_HARD_MAX_ENTRIES = 5000;
export const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_WRITE_HARD_MAX_BYTES = 16 * 1024 * 1024;

export const FileFetchToolSchema = Type.Object({
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

export const FILE_FETCH_TOOL_DESCRIPTOR: FileTransferToolDescriptor = {
  label: "File Fetch",
  name: "file_fetch",
  description:
    "Retrieve a file from a paired node by absolute path. Returns image content blocks for image MIME types, inlines small text files (≤8 KB) as text content, and saves everything else under the gateway media store with a path you can pass to file_write or other tools. Use this for screenshots, photos, receipts, logs, source files. Pair with file_write to copy a file from one node to another (no exec/cp shell-out needed). Requires operator opt-in: gateway.nodes.allowCommands must include 'file.fetch' AND plugins.entries.file-transfer.config.nodes.<node>.allowReadPaths must match the path. Without policy configured, every call is denied.",
  parameters: FileFetchToolSchema,
};

export const DirListToolSchema = Type.Object({
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

export const DIR_LIST_TOOL_DESCRIPTOR: FileTransferToolDescriptor = {
  label: "Directory List",
  name: "dir_list",
  description:
    "Retrieve a structured directory listing from a paired node. Returns file and subdirectory metadata (name, path, size, mimeType, isDir, mtime) without transferring file content. Use this to discover what files exist before fetching them with file_fetch. Pagination is offset-based; pass nextPageToken from the previous result. Requires operator opt-in: gateway.nodes.allowCommands must include 'dir.list' AND plugins.entries.file-transfer.config.nodes.<node>.allowReadPaths must match the directory path. Without policy configured, every call is denied.",
  parameters: DirListToolSchema,
};

export const DirFetchToolSchema = Type.Object({
  node: Type.String({
    description: "Node id, name, or IP. Resolves the same way as the nodes tool.",
  }),
  path: Type.String({
    description: "Absolute path to the directory on the node to fetch. Canonicalized server-side.",
  }),
  maxBytes: Type.Optional(
    Type.Number({
      description:
        "Max gzipped tarball bytes to fetch. Default 8 MB, hard ceiling 16 MB (single round-trip).",
    }),
  ),
  includeDotfiles: Type.Optional(
    Type.Boolean({
      description: "Reserved for v2; currently always includes dotfiles (v1 quirk in BSD tar).",
    }),
  ),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

export const DIR_FETCH_TOOL_DESCRIPTOR: FileTransferToolDescriptor = {
  label: "Directory Fetch",
  name: "dir_fetch",
  description:
    "Retrieve a directory tree from a paired node as a gzipped tarball, unpack it on the gateway, and return a manifest of saved paths. Use to pull source trees, asset folders, or log directories in a single round-trip. The unpacked files live on the GATEWAY (not your local machine); pass localPath into other tools or use file_fetch on individual entries to ship them elsewhere. Rejects trees larger than 16 MB compressed. Requires operator opt-in: gateway.nodes.allowCommands must include 'dir.fetch' AND plugins.entries.file-transfer.config.nodes.<node>.allowReadPaths must match the directory path.",
  parameters: DirFetchToolSchema,
};

export const FileWriteToolSchema = Type.Object({
  node: Type.String({ description: "Node id or display name to write the file on." }),
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
        "Media id returned by file_fetch. Preferred for binary copies because bytes stay in the gateway media store.",
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
    "Write file bytes to a paired node by absolute path. Atomic write (temp + rename). Refuses to overwrite by default — pass overwrite=true to replace. Refuses to write through symlink targets unless policy explicitly allows following symlinks. Pair with file_fetch by passing its mediaId as sourceMediaId for binary copy. Requires operator opt-in: gateway.nodes.allowCommands must include 'file.write' AND plugins.entries.file-transfer.config.nodes.<node>.allowWritePaths must match the destination path. Without policy configured, every call is denied.",
  parameters: FileWriteToolSchema,
};
