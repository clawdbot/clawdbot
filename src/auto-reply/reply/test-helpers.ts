/** Shared test fixtures for reply queue and typing-controller tests. */
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingController } from "./typing.js";

/** Creates a stateful reply-operation double without registering global run state. */
export function createMockReplyOperation(
  overrides: {
    abortSignal?: AbortSignal;
    key?: string;
    sessionId?: string;
    toolAuthorityFingerprint?: string;
  } = {},
) {
  const failMock = vi.fn();
  const freezeAbortMock = vi.fn();
  const retainFailureUntilCompleteMock = vi.fn();
  const updateSessionIdMock = vi.fn();
  const sessionId = overrides.sessionId ?? "session";
  let toolAuthorityFingerprint = overrides.toolAuthorityFingerprint;
  let toolAuthorityProjector:
    | Parameters<ReplyOperation["bindToolAuthorityProjector"]>[0]
    | undefined;
  let toolAuthorityRoute: ReplyOperation["toolAuthorityRoute"];
  const replyOperation: ReplyOperation = {
    key: overrides.key ?? "main",
    sessionId,
    turnKind: "visible",
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    resetTriggered: false,
    terminalRecovery: false,
    acceptedSteeredInboundAudio: false,
    get toolAuthorityFingerprint() {
      return toolAuthorityFingerprint;
    },
    get toolAuthorityRoute() {
      return toolAuthorityRoute;
    },
    phase: "running",
    result: null,
    staleExpiryReason: undefined,
    startedAtMs: Date.now(),
    lastActivityAtMs: Date.now(),
    hasOwnedSessionId: vi.fn((candidate: string) => candidate === sessionId),
    recordActivity: vi.fn(),
    setPhase: vi.fn(),
    markWaitingForDeferredMaintenance: vi.fn(),
    markDeferredMaintenanceWaitEnded: vi.fn(),
    markWaitingForGlobalLane: vi.fn(),
    markGlobalLaneWaitEnded: vi.fn(),
    markTerminalRecovery: vi.fn(),
    markAcceptedSteeredInboundAudio: vi.fn(),
    bindToolAuthorityFingerprint: vi.fn((fingerprint) => {
      toolAuthorityFingerprint = fingerprint;
    }),
    bindToolAuthorityProjector: vi.fn((projector) => {
      toolAuthorityProjector = projector;
    }),
    projectToolAuthorityFingerprint: vi.fn((overlay) =>
      toolAuthorityProjector && toolAuthorityRoute
        ? toolAuthorityProjector(overlay, toolAuthorityRoute)
        : undefined,
    ),
    bindToolAuthorityRoute: vi.fn((route) => {
      toolAuthorityRoute = route;
    }),
    updateSessionId: updateSessionIdMock,
    updateSessionKey: vi.fn(),
    attachBackend: vi.fn(),
    detachBackend: vi.fn(),
    freezeAbort: freezeAbortMock,
    retainFailureUntilComplete: retainFailureUntilCompleteMock,
    complete: vi.fn(),
    completeThen: vi.fn((afterClear) => afterClear()),
    completeWithAfterClearBarrier: vi.fn(),
    fail: failMock,
    abortByUser: vi.fn(() => true),
    abortForRestart: vi.fn(() => true),
    supersede: vi.fn(() => true),
  };
  return {
    replyOperation,
    failMock,
    freezeAbortMock,
    retainFailureUntilCompleteMock,
    updateSessionIdMock,
  };
}

/** Creates a typed mock typing controller with optional method overrides. */
export function createMockTypingController(
  overrides: Partial<TypingController> = {},
): TypingController {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
    ...overrides,
  };
}

/** Creates a minimal queued follow-up run fixture. */
export function createMockFollowupRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  const rootDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-mock-followup-");
  const skipProviderRuntimeHints = process.env.OPENCLAW_TEST_FAST === "1";
  const base: FollowupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    originatingTo: "channel:C1",
    run: {
      agentId: "main",
      agentDir: path.join(rootDir, "agent"),
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      agentAccountId: "primary",
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: {
        prompt: "",
        skills: [],
      },
      provider: "anthropic",
      model: "claude",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints,
    },
  };
  return {
    ...base,
    ...overrides,
    run: {
      ...base.run,
      ...overrides.run,
    },
  };
}
