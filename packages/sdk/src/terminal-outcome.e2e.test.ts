import { describe, expect, it, vi } from "vitest";
import { claimAgentSessionWriter } from "../../../src/agents/embedded-agent-runner/run/session-bootstrap.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../src/agents/embedded-agent-runner/runs.js";
import { resolveDefaultSessionStorePath } from "../../../src/config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../src/config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../src/config/sessions/types.js";
import { installGatewayTestHooks, startServer } from "../../../src/gateway/test-helpers.js";
import { getAgentEventLifecycleGeneration } from "../../../src/infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../src/infra/agent-run-registry.js";
import { withTimeout } from "../../../src/utils/with-timeout.js";
import { GatewayClientTransport, OpenClaw } from "./index.js";

describe("SDK writer takeover through the Gateway", () => {
  installGatewayTestHooks({ scope: "test" });

  it("reports the superseded writer as cancelled in events and waits", async () => {
    const token = "sdk-writer-takeover-token";
    const started = await startServer(token, { controlUiEnabled: false });
    const oc = new OpenClaw({
      transport: new GatewayClientTransport({
        url: `ws://127.0.0.1:${started.port}`,
        token,
        deviceIdentity: null,
        requestTimeoutMs: 2_000,
      }),
    });
    const sessionId = "sdk-writer-session";
    const sessionKey = "agent:main:dashboard:sdk-writer-takeover";
    const runId = "sdk-prior-writer";
    const nextRunId = "sdk-next-writer";
    const storePath = resolveDefaultSessionStorePath("main");
    const target = { agentId: "main", sessionKey, storePath };
    const cancellation = vi.fn(() => loadSessionEntry(target));
    const incumbent = {
      kind: "embedded" as const,
      runId,
      cancel: cancellation,
      abort: vi.fn(),
      isCompacting: () => false,
      isStreaming: () => true,
      queueMessage: async () => {},
    };

    try {
      await oc.connect();
      const sessionEntry = {
        sessionId,
        updatedAt: 1,
        lifecycleRevision: "sdk-writer-revision",
        activeWriterRunId: runId,
      } satisfies InternalSessionEntry;
      await replaceSessionEntry(target, sessionEntry);
      setActiveEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
      registerAgentRunContext(runId, {
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionId,
        sessionKey,
      });
      const run = await oc.runs.get(runId);
      const terminalEvent = (async () => {
        for await (const event of run.events()) {
          if (
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.cancelled" ||
            event.type === "run.timed_out"
          ) {
            return event.type;
          }
        }
        return undefined;
      })().catch((error: unknown) => error);

      await claimAgentSessionWriter({
        agentId: "main",
        prompt: "next turn",
        runId: nextRunId,
        sessionId,
        sessionKey,
        sessionTarget: { ...target, sessionId },
        timeoutMs: 30_000,
        workspaceDir: process.cwd(),
      });
      const [eventType, wait] = await Promise.all([
        withTimeout(terminalEvent, 2_000, {
          message: "timed out waiting for the superseded writer SDK event",
        }),
        run.wait({ timeoutMs: 500 }),
      ]);

      expect(cancellation).toHaveBeenCalledWith("superseded");
      expect(cancellation).toHaveReturnedWith(
        expect.objectContaining({ activeWriterRunId: nextRunId }),
      );
      expect(loadSessionEntry(target)).toMatchObject({ activeWriterRunId: nextRunId });
      expect({ eventType, waitStatus: wait.status }).toEqual({
        eventType: "run.cancelled",
        waitStatus: "cancelled",
      });
    } finally {
      clearActiveEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
      clearAgentRunContext(runId);
      await oc.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
