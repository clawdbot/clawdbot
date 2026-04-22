import { createEmbeddedRunReplayState } from "./pi-embedded-runner/replay-state.js";

export function createBaseToolHandlerState() {
  return {
    replayState: createEmbeddedRunReplayState(),
    toolMetaById: new Map<string, unknown>(),
    toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
    toolSummaryById: new Set<string>(),
    itemActiveIds: new Set<string>(),
    itemStartedCount: 0,
    itemCompletedCount: 0,
    lastToolError: undefined,
    pendingMessagingTexts: new Map<string, string>(),
    pendingMessagingTargets: new Map<string, unknown>(),
    pendingMessagingMediaUrls: new Map<string, string[]>(),
    pendingToolMediaUrls: [] as string[],
    pendingToolAudioAsVoice: false,
    pendingToolTrustedLocalMedia: false,
    deterministicApprovalPromptPending: false,
    messagingToolSentTexts: [] as string[],
    messagingToolSentTextsNormalized: [] as string[],
    messagingToolSentMediaUrls: [] as string[],
    messagingToolSentTargets: [] as unknown[],
    deterministicApprovalPromptSent: false,
    blockBuffer: "",
  };
}
