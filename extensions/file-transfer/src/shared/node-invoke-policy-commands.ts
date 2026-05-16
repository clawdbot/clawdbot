export const FILE_TRANSFER_NODE_INVOKE_COMMANDS = [
  "file.fetch",
  "dir.list",
  "dir.fetch",
  "file.write",
] as const;

export type FileTransferNodeInvokeCommand = (typeof FILE_TRANSFER_NODE_INVOKE_COMMANDS)[number];
