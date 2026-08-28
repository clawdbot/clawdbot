// Real-call proof that `sessions.list` produces `status: "queued"` for an
// admitted-but-not-executing run and that the `sessions_list` agent tool
// propagates it instead of dropping it.
import { expect, test } from "vitest";
import type { AgentToolGatewayRequestCaller } from "../agents/tools/in-process-gateway.js";
import { createSessionsListTool } from "../agents/tools/sessions-list-tool.js";
import { type ChatAbortControllerEntry, registerChatAbortController } from "./chat-abort.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

type SessionsListRow = {
  key?: string;
  sessionId?: string;
  status?: string;
  hasActiveRun?: boolean;
};

test("sessions.list projects a tracked-but-not-started run as status=queued", async () => {
  await createSessionStoreDir();
  const sessionId = "sess-queued";
  const sessionKey = "agent:main:queued";
  await writeSessionStore({
    entries: { queued: { sessionId, updatedAt: 1 } },
  });

  // Register a real tracked run that has not started executing. The Gateway
  // derives `status: "queued"` from matchingTrackedRuns.length > 0 with no
  // executionStarted (session-active-runs.ts:205-210).
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId: "queued-run",
    sessionId,
    sessionKey,
    agentId: "main",
    timeoutMs: 60_000,
    kind: "agent",
  });

  const result = await directSessionReq<{ sessions: SessionsListRow[] }>(
    "sessions.list",
    { includeUnknown: true },
    { context: { chatAbortControllers } as never },
  );

  expect(result.ok).toBe(true);
  const row = result.payload?.sessions.find((session) => session.key === sessionKey);
  expect(row?.hasActiveRun).toBe(true);
  expect(row?.status).toBe("queued");

  registration.cleanup({ force: true });
});

test("sessions_list agent tool propagates the Gateway's queued status", async () => {
  await createSessionStoreDir();
  const sessionId = "sess-queued-tool";
  const sessionKey = "agent:main:queued-tool";
  await writeSessionStore({
    entries: { "queued-tool": { sessionId, updatedAt: 1 } },
  });

  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId: "queued-run-tool",
    sessionId,
    sessionKey,
    agentId: "main",
    timeoutMs: 60_000,
    kind: "agent",
  });

  // Wire the tool's gateway call to the REAL sessions.list handler. No mock:
  // the handler reads the seeded session store and computes the queued status
  // from the tracked run registered above.
  const callGateway: AgentToolGatewayRequestCaller = async (request) => {
    const response = await directSessionReq<{ sessions: SessionsListRow[] }>(
      "sessions.list",
      (request.params ?? {}) as Record<string, unknown>,
      { context: { chatAbortControllers } as never },
    );
    if (!response.ok) {
      throw new Error(`sessions.list failed: ${response.error?.message ?? "unknown"}`);
    }
    return {
      sessions: response.payload?.sessions ?? [],
      hasMore: false,
      nextOffset: null,
    } as never;
  };

  const tool = createSessionsListTool({
    config: {
      agents: { entries: { main: { default: true } } },
      tools: { sessions: { visibility: "all" } },
    } as never,
    callGateway,
  });

  const output = await tool.execute("queued-tool-proof", {});
  const details = output.details as { sessions?: SessionsListRow[] };
  const row = details.sessions?.find((session) => session.key === sessionKey);
  expect(row?.status).toBe("queued");

  registration.cleanup({ force: true });
});
