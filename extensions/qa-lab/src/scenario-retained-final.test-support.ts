import { createServer } from "node:http";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher, settleReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { vi } from "vitest";
import {
  injectQaBusInboundMessage,
  qaChannelPlugin,
  type QaBusOutboundMessageInput,
} from "../../qa-channel/api.js";
import { closeQaHttpServer, dispatchQaHttpRequest, startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";

export async function startRetainedFinalScenario(
  params: {
    previewOnly?: boolean;
    failFinal?: boolean;
    duplicateFinal?: boolean;
    typedError?: boolean;
    finalRoute?: Partial<QaBusOutboundMessageInput>;
  } = {},
) {
  const scenario = readQaScenarioById("qa-channel-failed-tool-terminal-finalization");
  if (!scenario.execution.flow) {
    throw new Error("expected retained-final scenario flow");
  }
  const config = scenario.execution.config ?? {};
  const expectedReply = String(config.expectedReply);
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  const startFinal = createDeferred<void>();
  const previewSent = createDeferred<void>();
  const deleteStarted = createDeferred<void>();
  const releaseDelete = createDeferred<void>();
  const finalStarted = createDeferred<void>();
  const releaseFinal = createDeferred<void>();
  const controlCompleted = createDeferred<void>();
  const waitObserved = createDeferred<void>();
  let nextCheck = createDeferred<void>();
  let deadlineExpired = false;
  let outboundRequests = 0;

  // Keep the real HTTP bus mutation, but expose the deletion/response gap and
  // the subsequent unsent final as independent, deterministic boundaries.
  const proxy = createServer((req, res) => {
    dispatchQaHttpRequest(res, async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      let body = Buffer.concat(chunks).toString();
      const finalSend = req.url === "/v1/outbound/message" && ++outboundRequests > 1;
      if (finalSend) {
        finalStarted.resolve();
        await releaseFinal.promise;
        if (params.failFinal) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "injected final send failure" }));
          return;
        }
        body = JSON.stringify({ ...JSON.parse(body), ...params.finalRoute });
      }
      const forward = () =>
        fetch(`${bus.baseUrl}${req.url}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body,
        });
      const response = await forward();
      const text = await response.text();
      if (req.url === "/v1/actions/delete") {
        deleteStarted.resolve();
        await releaseDelete.promise;
      }
      if (finalSend && params.duplicateFinal) {
        await (await forward()).arrayBuffer();
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(text);
    });
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback proxy address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const transport = createQaChannelTransport(state);
  const cfg = transport.createGatewayConfig({ baseUrl });
  const runtime = createPluginRuntimeMock({
    channel: { inbound: { buildContext: buildChannelInboundEventContext } },
  });
  // Only model execution and session recording are injected. The real reply
  // dispatcher drains the real preview owner before the real poller can ack.
  vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
    async ({ ctx, dispatcherOptions, replyOptions }) => {
      if (ctx.CommandTurn?.kind === "native") {
        controlCompleted.resolve();
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }
      await replyOptions?.onToolStart?.({ phase: "start", name: "exec" });
      await replyOptions?.onPartialReply?.({ text: expectedReply });
      previewSent.resolve();
      await startFinal.promise;
      const dispatcher = createReplyDispatcher(dispatcherOptions);
      try {
        if (!params.previewOnly) {
          dispatcher.sendFinalReply({ text: expectedReply, isError: params.typedError });
        }
      } finally {
        await settleReplyDispatcher({ dispatcher });
      }
      return { queuedFinal: !params.previewOnly, counts: dispatcher.getQueuedCounts() };
    },
  );
  const controller = new AbortController();
  const ready = createDeferred<void>();
  const context = createStartAccountContext({
    account: qaChannelPlugin.config.resolveAccount(cfg, transport.accountId),
    cfg,
    abortSignal: controller.signal,
    statusPatchSink: (snapshot) => {
      if (snapshot.lifecycle === "ready") {
        ready.resolve();
      }
    },
  });
  const startAccount = qaChannelPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("expected QA channel gateway entry point");
  }
  const gateway = Promise.resolve(startAccount({ ...context, channelRuntime: runtime.channel }));
  const gatewaySettled = gateway.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const gatewayReady = Promise.race([
    ready.promise,
    gateway.then(() => {
      throw new Error("QA gateway stopped before ready");
    }),
  ]);
  const vars: Record<string, unknown> = {};
  const waitForCondition: typeof transport.waitForCondition = (check, timeoutMs, intervalMs) =>
    transport.waitForCondition(
      async () => {
        if (deadlineExpired) {
          throw new Error("injected processing acknowledgment deadline");
        }
        const result = await check();
        waitObserved.resolve();
        nextCheck.resolve();
        return result;
      },
      timeoutMs,
      intervalMs,
    );
  // These request/transcript facts isolate the delivery race. The actual QA
  // suite separately proves the real failed read, model requests and transcript.
  const requests = [
    {
      allInputText: config.promptSnippet,
      plannedToolName: "read",
      plannedWireToolName: "exec",
      plannedToolCallId: "failed-exec",
    },
    {
      allInputText: config.promptSnippet,
      toolOutputCallId: "failed-exec",
      body: {
        input: [
          {
            type: "function_call",
            name: "exec",
            call_id: "failed-exec",
            arguments: 'await tools.read({path:"qa-failed-terminal-missing-file.txt"})',
          },
          { type: "function_call_output", call_id: "failed-exec", output: "ENOENT" },
        ],
        tools: [{ name: "exec" }, { name: "wait" }],
      },
    },
  ];
  const result = runScenarioFlow({
    scenarioTitle: scenario.title,
    flow: scenario.execution.flow,
    vars,
    api: {
      scenario,
      config,
      state,
      transport: {
        accountId: transport.accountId,
        sendInbound: async (input: Parameters<typeof transport.sendInbound>[0]) =>
          (await injectQaBusInboundMessage({ baseUrl, input })).message,
        waitForOutbound: async (input: Parameters<typeof transport.waitForOutbound>[0]) => {
          const message = await transport.waitForOutbound(input);
          waitObserved.resolve();
          return message;
        },
      },
      env: { providerMode: "mock-openai", mock: { baseUrl: "http://mock.invalid" } },
      reset: () => transport.reset(),
      waitForGatewayHealthy: () => gatewayReady,
      waitForQaChannelReady: () => gatewayReady,
      waitForCondition,
      fetchJson: async (url: string) => {
        if (url.endsWith("/debug/request-cursor")) {
          return { cursor: 0 };
        }
        // On old YAML this forces its verdict into the empty retained interval.
        if (!params.previewOnly) {
          await deleteStarted.promise;
        }
        return requests;
      },
      readSessionTranscriptSummary: async () => ({
        assistantToolCallCounts: { exec: 1 },
        completedToolCallCounts: { exec: 1 },
        successfulToolCallCounts: {},
      }),
      runScenario: runQaSuiteScenarioSteps,
    },
  });
  return {
    state,
    vars,
    result,
    previewSent: Promise.race([
      previewSent.promise,
      result.then((outcome) => {
        throw new Error(`scenario ended before preview: ${outcome.details}`);
      }),
    ]),
    waitObserved: waitObserved.promise,
    startFinal: () => startFinal.resolve(),
    deleteStarted: deleteStarted.promise,
    releaseDelete: () => releaseDelete.resolve(),
    finalStarted: finalStarted.promise,
    releaseFinal: () => releaseFinal.resolve(),
    expireDeadline: () => {
      deadlineExpired = true;
    },
    async probePending() {
      nextCheck = createDeferred<void>();
      return await Promise.race([nextCheck.promise.then(() => undefined), result]);
    },
    async sendControl() {
      await injectQaBusInboundMessage({
        baseUrl,
        input: {
          conversation: { id: "control", kind: "direct" },
          senderId: "qa-driver",
          text: "/stop",
          nativeCommand: { name: "stop" },
        },
      });
      await controlCompleted.promise;
    },
    async stop() {
      deadlineExpired = true;
      startFinal.resolve();
      releaseDelete.resolve();
      releaseFinal.resolve();
      await result;
      controller.abort();
      const gatewayError = await gatewaySettled;
      await closeQaHttpServer(proxy);
      await bus.stop();
      if (gatewayError) {
        throw gatewayError;
      }
    },
  };
}
