/** Typed Stop exercises the real chat.send pipeline and collector cancellation owners. */
import { expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const fixture = useChatAbortRegistryFixture();

it.each(
  ["agent:main:main", "main"].flatMap((requestSessionKey) =>
    ["owned", "orphan", "foreign", "protected", "ordinary"].map((kind) => ({
      requestSessionKey,
      kind,
    })),
  ),
)(
  "typed Stop respects full-session collector ownership: $kind via $requestSessionKey",
  async ({ kind, requestSessionKey }) => {
    const sessionKey = "agent:main:main";
    const runningKey = "agent:main:subagent:running";
    const queuedKey = "agent:main:subagent:queued";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: "parent-session",
    });
    for (const [runId, childSessionKey] of [
      ["running", runningKey],
      ["queued", queuedKey],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: `${runId}-session`,
      });
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: sessionKey,
        requesterTurnRunId: "parent",
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: runId === "queued",
        expectsCompletionMessage: false,
      });
    }
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "typed-stop",
      runId: "queued",
      maxConcurrent: 1,
      activeRunIds: ["capacity"],
      start: dispatch,
      onStartFailure: () => true,
    });
    const runningAbort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "running", abort: runningAbort });
    setActiveEmbeddedRun("running-session", handle, runningKey);
    const parent = createActiveRun(sessionKey, {
      sessionId: "parent-session",
      agentId: "main",
      owner: { connId: kind === "foreign" ? "foreign" : "owner" },
      controlUiVisible: kind === "protected" ? false : undefined,
    });
    parent.controller.signal.addEventListener("abort", () => releaseSwarmRun("capacity"));
    const context = createChatAbortContext({ getRuntimeConfig });
    if (kind !== "orphan") {
      context.chatAbortControllers.set("parent", parent);
      context.chatRunState.getOrCreate("parent").buffer = "partial parent reply";
    }
    const canCascade = kind === "owned" || kind === "orphan";
    try {
      const respond = await invokeChatAbortHandler({
        handler:
          kind === "ordinary"
            ? handleChatAbortRequestWithLifecycle
            : (options) =>
                handleChatSend({
                  ...options,
                  params: {
                    sessionKey: requestSessionKey,
                    message: "/stop",
                    idempotencyKey: "typed-stop",
                  },
                }),
        context,
        request: { sessionKey: requestSessionKey },
        client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
      });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(kind !== "foreign");
      expect(parent.controller.signal.aborted).toBe(kind === "owned" || kind === "ordinary");
      expect(runningAbort).toHaveBeenCalledTimes(canCascade ? 1 : 0);
      for (const key of [runningKey, queuedKey]) {
        expect(getSubagentRunByChildSessionKey(key)?.execution.status).toBe(
          canCascade ? "terminal" : key === runningKey ? "running" : "queued",
        );
      }
      releaseSwarmRun("capacity");
      if (canCascade) {
        expect(dispatch).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: kind === "owned" ? ["parent"] : [],
        });
      } else {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      }
      const events = await loadTranscriptEvents({
        storePath,
        sessionKey,
        sessionId: "parent-session",
        agentId: "main",
      });
      if (kind === "owned") {
        expect(events).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              content: [{ type: "text", text: "partial parent reply" }],
              openclawAbort: expect.objectContaining({
                aborted: true,
                origin: "stop-command",
                runId: "parent",
              }),
            }),
          }),
        );
      }
    } finally {
      clearActiveEmbeddedRun("running-session", handle, runningKey);
      releaseSwarmRun("capacity");
      releaseSwarmRun("queued");
    }
  },
);
