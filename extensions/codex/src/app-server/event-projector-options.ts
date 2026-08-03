import type { CodexCompletedResponseUsage } from "./event-projector-response-usage.js";
import type { CodexThreadItem, JsonValue } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";

export type CodexAppServerEventProjectorOptions = {
  nativePostToolUseRelayEnabled?: boolean;
  onNativeToolResultRecorded?: () => void | Promise<void>;
  onToolStarted?: (toolCallId: string, startedAtMs: number) => void;
  onToolCompleted?: (toolCallId: string, completedAtMs: number) => void;
  onRawResponseCompleted?: (
    response: CodexCompletedResponseUsage & { completedAtMs: number },
  ) => void;
  prepareNativeMcpAppResultDetails?: (item: CodexThreadItem) => Promise<unknown>;
  readRecentRateLimits?: () => JsonValue | undefined;
  runAbortSignal?: AbortSignal;
  remoteWorkspaceRoot?: string;
  readRemoteWorkspaceFile?: CodexRemoteWorkspaceFileReader;
  remoteWorkspaceRequestTimeoutMs?: number;
  trajectoryRecorder?: CodexTrajectoryRecorder | null;
  onContextCompacted?: () => void;
  resolveDynamicToolResultContentSource?: (toolName: string) => "network" | undefined;
  upstreamUserText?: string;
};
