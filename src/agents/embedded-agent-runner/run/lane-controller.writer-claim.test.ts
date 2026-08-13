import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import { SessionTranscriptWriterClaimReboundError } from "../../../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../../infra/agent-events.js";
import { registerAgentRunContext } from "../../../infra/agent-run-registry.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../stream-message-shared.js";
import { log } from "../logger.js";
import { setActiveEmbeddedRun } from "../runs.js";
import { testing as runsTesting } from "../runs.test-support.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

const fixture = useTempSessionsFixture("lane-writer-claim-");
const sessionId = "writer-session";
const sessionKey = "agent:main:writer-session";
const lifecycleRevision = "writer-revision";

const completedResult: EmbeddedAgentRunResult = {
  payloads: [],
  meta: {
    durationMs: 0,
    agentMeta: { sessionId, provider: "openai", model: "gpt-test" },
  },
};

describe("embedded run durable writer admission", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    runsTesting.resetActiveEmbeddedRuns();
  });

  afterEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
  });

  it("supersedes the live prior writer, claims the row, and rejects its late append", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }, {
      activeWriterRunId: "run-a",
      lifecycleRevision,
      sessionId,
      updatedAt: 1,
    } as InternalSessionEntry);

    const takeoverOrder: string[] = [];
    const readWriter = () =>
      (
        loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }) as
          | InternalSessionEntry
          | undefined
      )?.activeWriterRunId;
    const cancelA = vi.fn(() => takeoverOrder.push(`cancel:${readWriter()}`));
    setActiveEmbeddedRun(
      sessionId,
      {
        kind: "embedded",
        runId: "run-a",
        cancel: cancelA,
        abort: vi.fn(),
        isCompacting: () => false,
        isStreaming: () => true,
        queueMessage: async () => {},
      },
      sessionKey,
      sessionKey,
    );
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("run-a", {
      agentId: "main",
      lifecycleGeneration,
      sessionId,
      sessionKey,
    });
    const staleManagerTarget = {
      agentId: "main",
      expectedLifecycleRevision: lifecycleRevision,
      expectedWriterRunId: "run-a",
      sessionId,
      sessionKey,
      storePath: fixture.storePath(),
    };
    const staleManager = SessionManager.open(staleManagerTarget, "/tmp");
    let supersededOutcome: AgentRunTerminalOutcome | undefined;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-a" && event.stream === "lifecycle" && event.data.phase === "end") {
        takeoverOrder.push(`record:${readWriter()}`);
        supersededOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase: "end",
          data: event.data,
          endedAt: event.data.endedAt,
        });
      }
    });

    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      agentId: "main",
      lifecycleGeneration,
      prompt: "hello",
      runId: "run-b",
      sessionFile: sessionKey,
      sessionId,
      sessionKey,
      sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      timeoutMs: 30_000,
      workspaceDir: "/tmp",
      enqueue: async (task) => await task(),
    };
    const controller = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => lifecycleGeneration,
      getParams: () => params,
      globalLane: "writer-global",
      initialQueuedLifecycleGeneration: lifecycleGeneration,
      sessionLane: "writer-session",
      setLifecycleGeneration: () => {},
      setParams: (next) => {
        params = next;
      },
    });

    try {
      await controller.enqueueSession(() => controller.enqueueGlobal(async () => completedResult));
    } finally {
      unsubscribe();
    }

    expect(cancelA).toHaveBeenCalledWith("superseded");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("live=true"));
    expect(takeoverOrder).toEqual(["record:run-b", "cancel:run-b"]);
    expect(supersededOutcome).toMatchObject({
      reason: "superseded",
      status: "error",
      stopReason: "superseded",
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }),
    ).toMatchObject({
      activeWriterRunId: "run-b",
      lifecycleRevision,
      sessionId,
    });
    expect(params.sessionTarget).toMatchObject({
      expectedLifecycleRevision: lifecycleRevision,
      expectedWriterRunId: "run-b",
    });
    expect(() =>
      staleManager.appendMessage(
        buildAssistantMessage({
          model: { api: "openai-responses", provider: "openai", id: "gpt-test" },
          content: [{ type: "text", text: "late model output" }],
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        }),
      ),
    ).toThrow(SessionTranscriptWriterClaimReboundError);

    const staleAppend = await appendExactAssistantMessageToSessionTranscript({
      agentId: "main",
      expectedLifecycleRevision: lifecycleRevision,
      expectedSessionId: sessionId,
      expectedWriterRunId: "run-a",
      message: buildAssistantMessage({
        model: { api: "openai-responses", provider: "openai", id: "gpt-test" },
        content: [{ type: "text", text: "late output" }],
        stopReason: "stop",
        usage: buildUsageWithNoCost({}),
      }),
      sessionKey,
      storePath: fixture.storePath(),
    });
    expect(staleAppend).toMatchObject({ ok: false, code: "session-rebound" });
  });

  it("silently replaces a persisted claim whose prior run is no longer live", async () => {
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }, {
      activeWriterRunId: "completed-run",
      lifecycleRevision,
      sessionId,
      updatedAt: 1,
    } as InternalSessionEntry);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    await claimAgentSessionWriter({
      agentId: "main",
      prompt: "next turn",
      runId: "run-next",
      sessionId,
      sessionKey,
      sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      timeoutMs: 30_000,
      workspaceDir: "/tmp",
    });

    expect(warn).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }),
    ).toMatchObject({ activeWriterRunId: "run-next" });
  });

  it("leaves the incumbent live when the replacement claim does not commit", async () => {
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }, {
      activeWriterRunId: "run-a",
      lifecycleRevision,
      sessionId,
      updatedAt: 1,
    } as InternalSessionEntry);
    const cancelA = vi.fn();
    setActiveEmbeddedRun(
      sessionId,
      {
        kind: "embedded",
        runId: "run-a",
        cancel: cancelA,
        abort: vi.fn(),
        isCompacting: () => false,
        isStreaming: () => true,
        queueMessage: async () => {},
      },
      sessionKey,
      sessionKey,
    );
    const lifecycleEvents: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-a" && event.stream === "lifecycle") {
        lifecycleEvents.push(event);
      }
    });
    vi.spyOn(sessionAccessor, "updateSessionEntry").mockRejectedValueOnce(
      new Error("replacement claim conflict"),
    );
    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      agentId: "main",
      prompt: "hello",
      runId: "run-b",
      sessionFile: sessionKey,
      sessionId,
      sessionKey,
      sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      timeoutMs: 30_000,
      workspaceDir: "/tmp",
      enqueue: async (task) => await task(),
    };
    const controller = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => getAgentEventLifecycleGeneration(),
      getParams: () => params,
      globalLane: "writer-global-conflict",
      initialQueuedLifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionLane: "writer-session-conflict",
      setLifecycleGeneration: () => {},
      setParams: (next) => {
        params = next;
      },
    });

    try {
      await expect(
        controller.enqueueSession(() => controller.enqueueGlobal(async () => completedResult)),
      ).rejects.toThrow("replacement claim conflict");
    } finally {
      unsubscribe();
    }

    expect(cancelA).not.toHaveBeenCalled();
    expect(lifecycleEvents).toEqual([]);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }),
    ).toMatchObject({ activeWriterRunId: "run-a" });
  });
});
