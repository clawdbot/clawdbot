import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

export type PreparedSessionPermissionPolicy = Readonly<{
  root: string;
  mode: SessionPermissionMode;
}>;

/** Filesystem policy for agent tools that can touch local paths. */
export type ToolFsPolicy = {
  workspaceOnly: boolean;
  root?: string;
  /** Host-owned roots that read-only tools may consume outside the workspace. */
  readOnlyRoots?: string[];
};
