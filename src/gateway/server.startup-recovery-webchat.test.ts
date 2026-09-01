import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
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
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

function writeAssistantResponse(response: ServerResponse, requestIndex: number): void {
  const message = {
    type: "message",
    id: `startup-recovery-${requestIndex}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "WEBCHAT_OK", annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `startup-recovery-response-${requestIndex}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

describe("Gateway startup recovery WebChat queue", () => {
  it.each([
    { caseName: "recovery completion", failRecovery: false },
    { caseName: "recovery failure", failRecovery: true },
  ])(
    "holds browser turns through $caseName, consumes cancellation, and executes the survivor once",
    { timeout: 90_000 },
    async ({ caseName, failRecovery }) => {
      const caseId = caseName.replaceAll(" ", "-");
      const token = `startup-recovery-webchat-${caseId}-token`;
      const state = await createOpenClawTestState({
        label: `startup-recovery-webchat-${caseId}`,
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
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let recovery: ReturnType<typeof recoverRestartAbortedMainSessions> | undefined;
      let replacementRecoveryAdmission:
        | Awaited<ReturnType<typeof beginSessionWorkAdmission>>
        | undefined;
      let releaseRecovery!: () => void;
      const recoveryRelease = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      const providerRequests: string[] = [];
      const targetProviderRequests: string[] = [];
      let gateNextProviderRequest = false;
      const sessionKey = "agent:main:main";
      const sessionId = "startup-recovery-session";
      const recoveryMessage = "Resume this interrupted task after restart.";
      const canceledMessage = "Cancel this queued browser turn.";
      const survivorMessage = "Run this browser turn after recovery.";

      try {
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        await replaceSessionEntry(
          { storePath, sessionKey },
          {
            sessionId,
            updatedAt: Date.now() + 60_000,
            status: "done",
          },
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

        providerServer = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            const requestBody = Buffer.concat(chunks).toString("utf8");
            providerRequests.push(requestBody);
            const isSessionTitleRequest = requestBody.includes("Generate a concise session title");
            if (
              !isSessionTitleRequest &&
              [recoveryMessage, canceledMessage, survivorMessage].some((message) =>
                requestBody.includes(message),
              )
            ) {
              targetProviderRequests.push(requestBody);
            }
            const requestIndex = providerRequests.length;
            const gateRecoveryRequest =
              gateNextProviderRequest &&
              !isSessionTitleRequest &&
              requestBody.includes(recoveryMessage);
            if (gateRecoveryRequest) {
              gateNextProviderRequest = false;
              await recoveryRelease;
              if (failRecovery) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(
                  JSON.stringify({
                    error: { message: "expected recovery failure", type: "invalid_request_error" },
                  }),
                );
                return;
              }
            }
            writeAssistantResponse(response, requestIndex);
          })().catch((error: unknown) => {
            response.writeHead(500).end(error instanceof Error ? error.message : String(error));
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("startup recovery provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
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
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: { default: true } },
          },
          messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
          models: {
            mode: "replace",
            providers: { [provider.providerId]: provider.config },
          },
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
        const gatewayClient = gateway.client;
        const warmupRunId = `startup-recovery-warmup-${caseId}`;
        await expect(
          gatewayClient.request("agent", {
            sessionKey: `agent:main:${warmupRunId}`,
            message: "Warm the real agent runtime before timing startup recovery.",
            deliver: false,
            idempotencyKey: warmupRunId,
          }),
        ).resolves.toMatchObject({ runId: warmupRunId, status: "accepted" });
        await expect(
          gatewayClient.request(
            "agent.wait",
            { runId: warmupRunId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        expect(providerRequests.length).toBeGreaterThan(0);
        providerRequests.length = 0;
        expect(targetProviderRequests).toEqual([]);

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
        gateNextProviderRequest = true;
        recovery = recoverRestartAbortedMainSessions({
          cfg,
          stateDir: state.stateDir,
          gatewayRuntime: recoveryRuntime,
        });
        await vi.waitFor(() => expect(targetProviderRequests).toHaveLength(1), {
          timeout: 30_000,
        });
        clearSessionStoreCacheForTest();
        const initialRecoveryOwnerRelease = getSessionWorkAdmissionOwnerRelease({
          scope: storePath,
          identities: [sessionKey, sessionId],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        });
        expect(initialRecoveryOwnerRelease).toBeInstanceOf(Promise);
        if (!initialRecoveryOwnerRelease) {
          throw new Error("startup recovery did not own the main session");
        }

        const canceledRunId = `webchat-canceled-during-${caseId}`;
        const survivorRunId = `webchat-survives-${caseId}`;
        await Promise.all(
          [
            [canceledRunId, canceledMessage],
            [survivorRunId, survivorMessage],
          ].map(([runId, message]) =>
            expect(
              gatewayClient.request("chat.send", {
                sessionKey,
                sessionId,
                message,
                deliver: false,
                queueMode: "followup",
                idempotencyKey: runId,
              }),
            ).resolves.toMatchObject({ runId, status: "started" }),
          ),
        );
        await vi.waitFor(() => {
          const queue = getExistingFollowupQueue(sessionKey);
          expect(new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])]).size).toBe(2);
        });
        replacementRecoveryAdmission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, sessionId],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          assertAllowed: () => {},
        });

        expect(targetProviderRequests[0]).toContain(recoveryMessage);
        expect(targetProviderRequests[0]).not.toContain(canceledMessage);
        expect(targetProviderRequests[0]).not.toContain(survivorMessage);
        await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
        releaseRecovery();
        await initialRecoveryOwnerRelease;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(targetProviderRequests).toHaveLength(1);

        await expect(
          gatewayClient.request("chat.abort", { sessionKey, runId: canceledRunId }),
        ).resolves.toMatchObject({ aborted: true, runIds: [canceledRunId] });
        await vi.waitFor(() => {
          const queue = getExistingFollowupQueue(sessionKey);
          expect(new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])]).size).toBe(1);
        });
        expect(targetProviderRequests).toHaveLength(1);

        replacementRecoveryAdmission.release();
        await vi.waitFor(() => expect(targetProviderRequests).toHaveLength(2), {
          timeout: 30_000,
        });
        expect(targetProviderRequests[1]).toContain(survivorMessage);
        expect(targetProviderRequests[1]).not.toContain(canceledMessage);
        await expect(
          gatewayClient.request(
            "agent.wait",
            { runId: survivorRunId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());
        expect(
          getSessionWorkAdmissionOwnerRelease({
            scope: storePath,
            identities: [sessionKey, sessionId],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          }),
        ).toBeUndefined();
        expect(targetProviderRequests).toHaveLength(2);
      } finally {
        releaseRecovery();
        replacementRecoveryAdmission?.release();
        if (recovery) {
          await Promise.allSettled([recovery]);
        }
        clearFollowupQueue(sessionKey);
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          providerServer.closeAllConnections();
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        await state.cleanup();
      }
    },
  );
});
