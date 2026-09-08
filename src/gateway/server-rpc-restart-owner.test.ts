import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as followupDelivery from "../auto-reply/reply/followup-delivery.js";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureGatewaySessionWorkAdmissions,
  getSessionWorkAdmissionRelease,
} from "../sessions/session-lifecycle-admission.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "records an actual RPC queued reply awaiting final delivery during restart",
  { timeout: 120_000 },
  async () => {
    const token = "synthetic-rpc-owner-token";
    const state = await createOpenClawTestState({
      label: "rpc-restart-owner",
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
    const sessionKey = "agent:main:rpc-restart-owner";
    const firstGate = createDeferred();
    const finalGate = createDeferred();
    const finalReached = createDeferred();
    let firstReceived = false;
    let followupReceived = false;
    const tasks = new Set<Promise<void>>();
    const providerServer = createServer((request, response) => {
      const task = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const followup = body.includes("SYNTHETIC_QUEUED_REPLY");
        const first = !followup && body.includes("SYNTHETIC_FIRST_REPLY");
        if (first) {
          firstReceived = true;
          await firstGate.promise;
        }
        if (followup) {
          followupReceived = true;
        }
        if (!response.destroyed) {
          writeOpenAiResponsesText(response, {
            text: followup ? "QUEUED_REPLY_FOR_RECOVERY" : "FIRST_REPLY_COMPLETE",
            messageId: followup ? "queued-message" : "first-message",
            responseId: followup ? "queued-response" : "first-response",
          });
        }
      })().catch((error: unknown) => {
        if (!response.destroyed) {
          response.writeHead(500).end(String(error));
        }
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let closed = false;
    let replyReleased: Promise<void> | undefined;
    let hostResolver: GatewayContextResolver | undefined;
    let context: GatewayRequestContext | undefined;
    const kernel = await import("./server-kernel-request-runtime.js");
    const prepare = kernel.prepareGatewayKernelRequestRuntime;
    const startupSpy = vi
      .spyOn(kernel, "prepareGatewayKernelRequestRuntime")
      .mockImplementation(async (params) => {
        hostResolver = params.coreRuntime.resolvePluginGatewayContext;
        const result = await prepare(params);
        context = result.gatewayRequestContext;
        return result;
      });
    const deliver = followupDelivery.deliverFollowupDecision;
    const deliverySpy = vi
      .spyOn(followupDelivery, "deliverFollowupDecision")
      .mockImplementation(async (params) => {
        if (
          params.decision.kind === "deliver" &&
          params.kind !== "tool" &&
          params.kind !== "block"
        ) {
          finalReached.resolve();
          await finalGate.promise;
        }
        return await deliver(params);
      });
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "gpt-rpc-owner-proof",
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: {} },
        },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { mode: "token", token } },
        plugins: { slots: { memory: "none" } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({ cfg, configPath: state.configPath, token });
      startupSpy.mockRestore();
      await gateway.server.startupSettled;
      await gateway.client.request("chat.send", {
        sessionKey,
        message: "SYNTHETIC_FIRST_REPLY",
        idempotencyKey: "rpc-first",
        queueMode: "followup",
      });
      await vi.waitFor(() => expect(firstReceived).toBe(true), { timeout: 60_000 });
      await gateway.client.request("chat.send", {
        sessionKey,
        message: "SYNTHETIC_QUEUED_REPLY",
        idempotencyKey: "rpc-queued",
        queueMode: "followup",
      });
      await vi.waitFor(() => expect(context?.chatQueuedTurns.has("rpc-queued")).toBe(true));
      firstGate.resolve();
      await finalReached.promise;
      expect(followupReceived).toBe(true);
      if (!context || !hostResolver || !context.resolveGatewayContext) {
        throw new Error("Missing actual Gateway resolver");
      }
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const entry = sessionAccessor.loadSessionEntry({ storePath, sessionKey });
      if (!entry) {
        throw new Error("Real RPC did not create a session");
      }
      const target = { scope: storePath, sessionKey, sessionId: entry.sessionId };
      replyReleased = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [sessionKey],
      });
      expect(captureGatewaySessionWorkAdmissions(() => context).isActive(target)).toBe(false);
      console.log(
        "RPC_OWNER_BEFORE_CLOSE",
        JSON.stringify({
          status: entry.status,
          operation: replyRunRegistry.get(sessionKey)?.turnKind,
          activeChatRuns: context.chatAbortControllers.size,
          queued: context.chatQueuedTurns.size,
          hostCaptured: captureGatewaySessionWorkAdmissions(hostResolver).isActive(target),
          rpcCaptured: captureGatewaySessionWorkAdmissions(context.resolveGatewayContext).isActive(
            target,
          ),
        }),
      );
      await gateway.server.close({
        reason: "synthetic queued reply restart",
        restartExpectedMs: 123,
        drainTimeoutMs: 0,
      });
      closed = true;
      const after = sessionAccessor.loadSessionEntry({ storePath, sessionKey });
      console.log(
        "RPC_OWNER_AFTER_CLOSE",
        JSON.stringify({
          marker: after?.abortedLastRun === true,
          safeTools: after?.restartRecoveryForceSafeTools === true,
          status: after?.status,
        }),
      );
      expect(after?.abortedLastRun).toBe(true);
      expect(after?.restartRecoveryForceSafeTools).toBe(true);
      expect(context.resolveGatewayContext()).toBeUndefined();
    } finally {
      startupSpy.mockRestore();
      deliverySpy.mockRestore();
      firstGate.resolve();
      finalGate.resolve();
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        if (!closed) {
          await gateway.server.close().catch(() => undefined);
        }
      }
      await replyReleased;
      providerServer.closeAllConnections();
      if (providerServer.listening) {
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
      }
      await Promise.allSettled(tasks);
      await state.cleanup();
    }
  },
);
