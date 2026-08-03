// Shared option/result types for node CLI command modules.
/** Common Gateway/node options consumed across node CLI subcommands. */
export type NodesRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  command?: string;
  params?: string;
  invokeTimeout?: string;
  idempotencyKey?: string;
  connected?: boolean;
  lastConnected?: string;
  target?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  js?: string;
  jsonl?: string;
  text?: string;
  cwd?: string;
  env?: string[];
  commandTimeout?: string;
  needsScreenRecording?: boolean;
  title?: string;
  body?: string;
  sound?: string;
  priority?: string;
  delivery?: string;
  name?: string;
  facing?: string;
  format?: string;
  maxWidth?: string;
  quality?: string;
  delayMs?: string;
  deviceId?: string;
  maxAge?: string;
  accuracy?: string;
  locationTimeout?: string;
  duration?: string;
  screen?: string;
  fps?: string;
  audio?: boolean;
};

/** Node list, paired-node, and pending-request payload types from shared parsers. */
export type { NodeListNode, PairedNode, PendingRequest } from "../../shared/node-list-types.js";
