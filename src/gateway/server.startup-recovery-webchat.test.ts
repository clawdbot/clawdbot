import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../agents/main-session-recovery/main-session-recovery-admission.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionOwnerRelease,
} from "../sessions/session-lifecycle-admission.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { countPendingQueueItems } from "../utils/queue-helpers.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "queues WebChat behind startup recovery, consumes cancellation, and executes the survivor once",
  { timeout: 90_000 },
  async () => {
    const token = "startup-recovery-webchat-token";
    const state = await createOpenClawTestState({
      label: "startup-recovery-webchat",
      env: {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const sessionKey = "agent:main:main";
    const sessionId = "startup-recovery-session";
    const recoveryMessage = "Resume this interrupted task after restart.";
    const canceledMessage = "Cancel this queued browser turn.";
    const survivorMessage = "Run this browser turn after recovery.";
    const recoveryGate = createDeferred();
    const targetRequests: string[] = [];
    let holdRecovery = false;
    let providerRequestCount = 0;
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const isTitleRequest = body.includes("Generate a concise session title");
        if (
          !isTitleRequest &&
          [recoveryMessage, canceledMessage, survivorMessage].some((text) => body.includes(text))
        ) {
          targetRequests.push(body);
        }
        if (holdRecovery && !isTitleRequest && body.includes(recoveryMessage)) {
          holdRecovery = false;
          await recoveryGate.promise;
        }
        providerRequestCount += 1;
        writeOpenAiResponsesText(response, {
          text: "WEBCHAT_OK",
          messageId: `startup-recovery-${providerRequestCount}`,
          responseId: `startup-recovery-response-${providerRequestCount}`,
        });
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let recovery: ReturnType<typeof recoverRestartAbortedMainSessions> | undefined;
    let replacementOwner: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;

    try {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId, updatedAt: Date.now() + 60_000, status: "done" },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          cwd: state.workspaceDir,
          message: {
            role: "user",
            content: recoveryMessage,
            idempotencyKey: "startup-recovery-source:user",
          },
        },
      );
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("startup recovery provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "gpt-startup-recovery-webchat",
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            maxConcurrent: 1,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: { default: true } },
        },
        messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { mode: "token", token } },
        plugins: { slots: { memory: "none" } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        clientDisplayName: "startup-recovery-webchat",
      });
      await gateway.server.startupSettled;
      const client = gateway.client;

      const warmupRunId = "startup-recovery-warmup";
      await client.request("agent", {
        sessionKey: `agent:main:${warmupRunId}`,
        message: "Warm the agent runtime before timing recovery.",
        deliver: false,
        idempotencyKey: warmupRunId,
      });
      await expect(
        client.request("agent.wait", { runId: warmupRunId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(providerRequestCount).toBeGreaterThan(0);
      targetRequests.length = 0;

      await replaceSessionEntry(
        { storePath, sessionKey },
        {
          sessionId,
          updatedAt: Date.now() - 10_000,
          status: "running",
          abortedLastRun: true,
        },
      );
      clearSessionStoreCacheForTest();
      const recoveryRuntime = getGatewayRecoveryRuntime();
      if (!recoveryRuntime) {
        throw new Error("Gateway recovery runtime is unavailable");
      }
      holdRecovery = true;
      recovery = recoverRestartAbortedMainSessions({
        cfg,
        stateDir: state.stateDir,
        gatewayRuntime: recoveryRuntime,
      });
      await vi.waitFor(() => expect(targetRequests).toHaveLength(1), { timeout: 30_000 });
      const initialOwner = getSessionWorkAdmissionOwnerRelease({
        scope: storePath,
        identities: [sessionKey, sessionId],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      });
      expect(initialOwner).toBeInstanceOf(Promise);
      if (!initialOwner) {
        throw new Error("startup recovery did not own the main session");
      }

      const canceledRunId = "webchat-canceled-during-recovery";
      const survivorRunId = "webchat-survives-recovery";
      const expectedQueuedMessages = new Map([
        [canceledRunId, canceledMessage],
        [survivorRunId, survivorMessage],
      ]);
      const sendQueuedTurn = async (runId: string, message: string) => {
        await expect(
          client.request("chat.send", {
            sessionKey,
            sessionId,
            message,
            deliver: false,
            queueMode: "followup",
            idempotencyKey: runId,
          }),
        ).resolves.toMatchObject({ runId, status: "started" });
      };
      // Hold the cancellation target in flight before queueing the survivor.
      // A started ACK precedes insertion into the followup queue.
      await sendQueuedTurn(canceledRunId, canceledMessage);
      await vi.waitFor(() => {
        const queue = getExistingFollowupQueue(sessionKey);
        expect([...(queue?.inFlight ?? [])].map((item) => item.messageId)).toEqual([canceledRunId]);
      });
      await sendQueuedTurn(survivorRunId, survivorMessage);
      await vi.waitFor(() => {
        const queue = getExistingFollowupQueue(sessionKey);
        // Active sources remain in items; started ACKs can precede queue admission.
        expect(queue?.items).toHaveLength(expectedQueuedMessages.size);
        expect(new Map(queue?.items.map(({ messageId, prompt }) => [messageId, prompt]))).toEqual(
          expectedQueuedMessages,
        );
        expect(queue?.inFlight).toHaveLength(1);
        expect(queue?.items.map((item) => item.messageId)).toEqual([canceledRunId, survivorRunId]);
        expect(countPendingQueueItems(queue?.items ?? [], queue?.inFlight)).toBe(1);
        expect(targetRequests).toHaveLength(1);
      });
      replacementOwner = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        assertAllowed: () => {},
      });

      recoveryGate.resolve();
      await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
      await initialOwner;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(targetRequests).toHaveLength(1);
      await expect(
        client.request("chat.abort", { sessionKey, runId: canceledRunId }),
      ).resolves.toMatchObject({ aborted: true, runIds: [canceledRunId] });
      await vi.waitFor(() => {
        const queue = getExistingFollowupQueue(sessionKey);
        const queued = new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])]);
        expect(Array.from(queued, (item) => item.messageId)).toEqual([survivorRunId]);
      });

      replacementOwner.release();
      await vi.waitFor(() => expect(targetRequests).toHaveLength(2), { timeout: 30_000 });
      expect(targetRequests[1]).toContain(survivorMessage);
      expect(targetRequests[1]).not.toContain(canceledMessage);
      await expect(
        client.request("agent.wait", { runId: survivorRunId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());
      expect(targetRequests).toHaveLength(2);
    } finally {
      recoveryGate.resolve();
      replacementOwner?.release();
      if (recovery) {
        await Promise.allSettled([recovery]);
      }
      clearFollowupQueue(sessionKey);
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close().catch(() => undefined);
      }
      if (providerServer.listening) {
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
      }
      await state.cleanup();
    }
  },
);
