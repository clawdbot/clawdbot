import type { IncomingMessage, ServerResponse } from "node:http";

export type NodeWorkspaceTransferHttpRoute =
  | {
      kind: "manifest" | "pack";
      direction: "download";
      environmentId: string;
      manifestRef: string;
    }
  | { kind: "blob"; direction: "download"; environmentId: string; sha256: string }
  | {
      kind: "reconcile";
      direction: "upload";
      environmentId: string;
      baseManifestRef: string;
    };

type NodeWorkspaceTransferHttpCallbackResult =
  | { kind: "unauthorized" }
  | { kind: "authorized"; handle: () => Promise<void> | void };

/** Authenticates a parsed transfer route before its body or response stream is consumed. */
export type NodeWorkspaceTransferHttpCallback = (params: {
  req: IncomingMessage;
  res: ServerResponse;
  route: NodeWorkspaceTransferHttpRoute;
  bearer: string;
}) => Promise<NodeWorkspaceTransferHttpCallbackResult>;
