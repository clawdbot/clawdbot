import type { OpenClawConfig } from "../../config/types.openclaw.js";

type CoordinatedTargetSessionIdentity = {
  sessionId: string;
  lifecycleRevision?: string;
};

export type TargetSessionProjectionCompletion = {
  status: "committed" | "skipped";
  warnings: number;
};

/** Closure-owned state shared by one heartbeat run and its local message sends. */
export type TargetSessionProjectionCoordinator = {
  readCurrentConfig: () => OpenClawConfig;
  sessions: Map<string, CoordinatedTargetSessionIdentity>;
  completions: Set<Promise<TargetSessionProjectionCompletion>>;
};
