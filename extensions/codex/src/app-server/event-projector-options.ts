import type { CodexThreadItem, JsonValue } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";

export type CodexAppServerEventProjectorOptions = {
  initialContextTokens?: number;
  nativePostToolUseRelayEnabled?: boolean;
  onNativeToolResultRecorded?: () => void | Promise<void>;
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
