import type { AgentPlanStep } from "openclaw/plugin-sdk/channel-outbound";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { CodexThreadItem, JsonValue } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";

export type CodexAsyncDeliverySettlement = "settled" | "retry";

export type CodexAppServerEventProjectorOptions = {
  initialContextTokens?: number;
  nativePostToolUseRelayEnabled?: boolean;
  asyncUserMessageAllowed?: boolean;
  onAsyncDelivery?: (delivery: {
    itemId: string;
    message: AssistantMessage;
    text: string;
  }) => CodexAsyncDeliverySettlement | Promise<CodexAsyncDeliverySettlement>;
  onNativeToolResultRecorded?: () => void | Promise<void>;
  onNativePlanUpdate?: (update: {
    markdown?: string;
    steps: AgentPlanStep[];
  }) => void | Promise<void>;
  prepareNativeMcpAppResultDetails?: (item: CodexThreadItem) => Promise<unknown>;
  readRecentRateLimits?: () => JsonValue | undefined;
  runAbortSignal?: AbortSignal;
  remoteWorkspaceRoot?: string;
  readRemoteWorkspaceFile?: CodexRemoteWorkspaceFileReader;
  remoteWorkspaceRequestTimeoutMs?: number;
  trajectoryRecorder?: CodexTrajectoryRecorder | null;
  onContextCompacted?: () => void | Promise<void>;
  resolveDynamicToolResultContentSource?: (toolName: string) => "network" | undefined;
  upstreamUserText?: string;
};
