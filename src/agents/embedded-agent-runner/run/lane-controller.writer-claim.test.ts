import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
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
import { setActiveEmbeddedRun } from "../runs.js";
import { testing as runsTesting } from "../runs.test-support.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

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
    ).toThrow("Session transcript header was not persisted");

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
});
