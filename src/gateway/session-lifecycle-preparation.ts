import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";

export type GatewaySessionTitleModelSelection = Pick<
  SessionEntry,
  "agentRuntimeOverride" | "authProfileOverride" | "modelOverride" | "providerOverride"
>;

export type PreparedGatewaySessionLifecycle = {
  spawnedCwd?: string;
  sessionRoot?: string;
  worktree?: NonNullable<SessionEntry["worktree"]>;
  repositoryWorkspaceId?: string;
  rollback?: () => Promise<void>;
};

export type PrepareGatewaySessionLifecycle = (target: {
  agentId: string;
  entry?: SessionEntry;
  key: string;
  storePath: string;
  titleModelSelection?: GatewaySessionTitleModelSelection | null;
}) => Promise<Result<PreparedGatewaySessionLifecycle, ErrorShape>>;

export async function rollbackGatewaySessionPreparation(params: {
  onError?: (error: unknown) => void;
  prepared?: PreparedGatewaySessionLifecycle;
}): Promise<void> {
  try {
    await params.prepared?.rollback?.();
  } catch (error) {
    params.onError?.(error);
  }
}
