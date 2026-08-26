import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

export type PreparedSessionPermissionPolicy = Readonly<{
  root: string;
  mode: SessionPermissionMode;
}>;

/** Filesystem policy for agent tools that can touch local paths. */
export type ToolFsPolicy = {
  workspaceOnly: boolean;
  root?: string;
};
