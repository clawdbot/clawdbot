/**
 * Fixtures for embedded agent tool-handler state tests.
 * Keeps large mutable handler state construction centralized so assertions can
 * focus on the field under test.
 */
import { createEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";

/** Build the minimal mutable state object expected by tool handler tests. */
export function createBaseToolHandlerState() {
  return {
    replayState: createEmbeddedRunReplayState(),
    toolMetaById: new Map<string, unknown>(),
    toolMetas: [] as Array<{ toolName?: string; meta?: string; asyncStarted?: boolean }>,
    acceptedSessionSpawns: [],
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
    toolExecutionSinceLastBlockReply: false,
    messagingToolSentTexts: [] as string[],
    messagingToolSentTextsNormalized: [] as string[],
    messagingToolSentMediaUrls: [] as string[],
    messagingToolSourceReplyPayloads: [],
    messagingToolSentTargets: [] as unknown[],
    deterministicApprovalPromptSent: false,
    blockBuffer: "",
  };
}
