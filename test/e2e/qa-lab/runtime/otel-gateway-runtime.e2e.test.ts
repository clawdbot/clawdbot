import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  createQaBusState,
  startQaBusServer,
  startQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { type CapturedSpan, startLocalOtlpReceiver } from "./otel-test-support.js";

async function startOtlpReceiver() {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  return { ...receiver, baseUrl: `http://127.0.0.1:${port}` };
}

async function settleCleanup(...cleanups: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "diagnostics-otel gateway cleanup failed");
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 30_000,
  timeoutContext?: () => unknown,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  const context = timeoutContext?.();
  throw new Error(
    `timed out waiting for QA runtime evidence${
      context === undefined ? "" : `: ${JSON.stringify(context)}`
    }`,
  );
}

function indexSpansById(spans: CapturedSpan[]): Map<string, CapturedSpan> {
  return new Map(spans.flatMap((span) => (span.spanId ? ([[span.spanId, span]] as const) : [])));
}

function expectResolvedParent(
  span: CapturedSpan,
  spansById: ReadonlyMap<string, CapturedSpan>,
): CapturedSpan {
  expect(span.parentSpanId).toBeTruthy();
  const parent = span.parentSpanId ? spansById.get(span.parentSpanId) : undefined;
  expect(parent).toBeDefined();
  return parent!;
}

describe("diagnostics-otel gateway runtime", () => {
  test("exports linked success and failed-tool recovery spans from a real qa-channel run", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const state = createQaBusState();
    const transport = {
      requiredPluginIds: ["qa-channel"],
      createGatewayConfig: ({ baseUrl }: { baseUrl: string }) => ({
        channels: {
          "qa-channel": {
            enabled: true,
            baseUrl,
            botUserId: "openclaw",
            botDisplayName: "OpenClaw QA",
            allowFrom: ["*"],
            pollTimeoutMs: 250,
          },
        },
        messages: {
          visibleReplies: "automatic" as const,
          groupChat: {
            mentionPatterns: ["\\b@?openclaw\\b"],
            visibleReplies: "automatic" as const,
          },
        },
      }),
    };
    let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
    let receiver: Awaited<ReturnType<typeof startOtlpReceiver>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;

    try {
      bus = await startQaBusServer({ state });
      const activeReceiver = await startOtlpReceiver();
      receiver = activeReceiver;
      mock = await startQaMockOpenAiServer();
      gateway = await startQaGatewayChild({
        repoRoot,
        useRepoCli: true,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        transport,
        transportBaseUrl: bus.baseUrl,
        enabledPluginIds: ["diagnostics-otel"],
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          tools: {
            ...cfg.tools,
            codeMode: {
              ...(typeof cfg.tools?.codeMode === "object" ? cfg.tools.codeMode : {}),
              enabled: true,
            },
          },
          diagnostics: {
            enabled: true,
            otel: {
              enabled: true,
              endpoint: activeReceiver.baseUrl,
              protocol: "http/protobuf",
              traces: true,
              metrics: false,
              logs: false,
              sampleRate: 1,
              flushIntervalMs: 1000,
              captureContent: false,
            },
          },
        }),
      });
      const conversation = { id: "qa-operator", kind: "direct" as const };
      const send = async (text: string) => {
        const cursor = state.getSnapshot().messages.length;
        state.addInboundMessage({
          conversation,
          senderId: "qa-user",
          senderName: "QA User",
          text,
        });
        return await waitFor(() =>
          state
            .getSnapshot()
            .messages.slice(cursor)
            .find(
              (message) =>
                message.direction === "outbound" && message.conversation.id === conversation.id,
            ),
        );
      };

      const successful = await send(
        "Tool progress QA check: use the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. After that read completes, reply with only this exact marker and no other text: `OTEL-GATEWAY-SUCCESS-OK`.",
      );
      expect(successful.direction).toBe("outbound");
      expect(successful.text).toContain("OTEL-GATEWAY-SUCCESS-OK");

      const requestCursor = (await fetch(`${mock.baseUrl}/debug/request-cursor`).then((response) =>
        response.json(),
      )) as { cursor: number };
      const recovered = await send(
        "Failed tool terminal recovery QA check: read the missing workspace file, then respond with exact marker: `QA-FAILED-TOOL-FINALIZED-OK`.",
      );
      expect(recovered.direction).toBe("outbound");
      expect(recovered.text).toContain("The requested file could not be read: ENOENT.");
      expect(recovered.text).toContain("QA-FAILED-TOOL-FINALIZED-OK");

      const scenarioRequests = (await fetch(
        `${mock.baseUrl}/debug/requests?after=${requestCursor.cursor}`,
      ).then((response) => response.json())) as Array<{
        allInputText?: string;
        body?: { input?: Array<Record<string, unknown>>; tools?: unknown[] };
        plannedToolName?: string;
        plannedWireToolName?: string;
        toolOutputCallId?: string;
      }>;
      const readPlans = scenarioRequests.filter((request) => request.plannedToolName === "read");
      const finalizations = scenarioRequests.filter((request) =>
        String(request.allInputText ?? "").includes(
          "The previous assistant turn completed its tool calls but did not produce a user-visible answer.",
        ),
      );
      expect(readPlans).toHaveLength(1);
      expect(readPlans[0]?.plannedWireToolName).toBe("exec");
      expect(finalizations).toHaveLength(1);
      expect(finalizations[0]?.body?.tools ?? []).toHaveLength(0);
      expect(finalizations[0]?.allInputText).toContain(
        "state that failure plainly and do not claim it succeeded",
      );
      const finalizationInput = finalizations[0]?.body?.input ?? [];
      const failedExecCalls = finalizationInput.filter(
        (item) =>
          item.type === "function_call" &&
          item.name === "exec" &&
          String(item.arguments ?? "").includes("qa-failed-terminal-missing-file.txt"),
      );
      const failedExecOutputs = finalizationInput.filter(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === failedExecCalls[0]?.call_id &&
          /ENOENT|no such file/iu.test(String(item.output ?? "")),
      );
      expect(failedExecCalls).toHaveLength(1);
      expect(failedExecOutputs).toHaveLength(1);
      expect(finalizations[0]?.toolOutputCallId).toBe(failedExecCalls[0]?.call_id);

      const failureEvidence = await waitFor(
        () => {
          const toolError = activeReceiver.capturedSpans.find(
            (span) =>
              span.name === "openclaw.tool.execution" &&
              span.statusCode === 2 &&
              span.attributes["openclaw.toolName"] === "read" &&
              Boolean(span.attributes["openclaw.errorCategory"]),
          );
          if (!toolError?.traceId) {
            return undefined;
          }
          const sameTrace = activeReceiver.capturedSpans.filter(
            (span) => span.traceId === toolError.traceId,
          );
          const runs = sameTrace.filter((span) => span.name === "openclaw.run");
          const harnesses = sameTrace.filter((span) => span.name === "openclaw.harness.run");
          const modelCalls = sameTrace.filter((span) => span.name === "openclaw.model.call");
          // QA-channel inbound replies use the channel-owned direct callback, not
          // deliver-core; the outbound bus receipt above is the delivery proof.
          const terminal = sameTrace.find(
            (span) =>
              span.name === "openclaw.message.processed" &&
              span.attributes["openclaw.channel"] === "qa-channel" &&
              span.attributes["openclaw.outcome"] === "completed",
          );
          return runs.length >= 2 && harnesses.length >= 2 && modelCalls.length >= 2 && terminal
            ? { harnesses, modelCalls, runs, sameTrace, terminal, toolError }
            : undefined;
        },
        45_000,
        () => ({
          requests: activeReceiver.capturedRequests,
          spans: activeReceiver.capturedSpans.map((span) => ({
            attributes: span.attributes,
            name: span.name,
            parentSpanId: span.parentSpanId,
            spanId: span.spanId,
            statusCode: span.statusCode,
            traceId: span.traceId,
          })),
        }),
      );

      const failureSpansById = indexSpansById(failureEvidence.sameTrace);
      expect(failureEvidence.terminal.parentSpanId).toBeFalsy();
      for (const harness of failureEvidence.harnesses) {
        expect(expectResolvedParent(harness, failureSpansById)).toBe(failureEvidence.terminal);
      }
      for (const run of failureEvidence.runs) {
        expect(expectResolvedParent(run, failureSpansById).name).toBe("openclaw.harness.run");
      }
      for (const modelCall of failureEvidence.modelCalls) {
        expect(expectResolvedParent(modelCall, failureSpansById).name).toBe("openclaw.run");
      }
      expect(expectResolvedParent(failureEvidence.toolError, failureSpansById).name).toBe(
        "openclaw.run",
      );

      const successEvidence = activeReceiver.capturedSpans.find(
        (span) =>
          span.name === "openclaw.tool.execution" &&
          span.statusCode !== 2 &&
          span.attributes["openclaw.toolName"] === "read" &&
          span.traceId !== failureEvidence.toolError.traceId,
      );
      expect(successEvidence).toBeTruthy();
      const successTrace = activeReceiver.capturedSpans.filter(
        (span) => span.traceId === successEvidence?.traceId,
      );
      const successTerminal = successTrace.find(
        (span) =>
          span.name === "openclaw.message.processed" &&
          span.attributes["openclaw.channel"] === "qa-channel" &&
          span.attributes["openclaw.outcome"] === "completed",
      );
      const successHarnesses = successTrace.filter((span) => span.name === "openclaw.harness.run");
      const successRuns = successTrace.filter((span) => span.name === "openclaw.run");
      const successModelCalls = successTrace.filter((span) => span.name === "openclaw.model.call");
      expect(successTerminal).toBeDefined();
      expect(successHarnesses.length).toBeGreaterThanOrEqual(1);
      expect(successRuns.length).toBeGreaterThanOrEqual(1);
      expect(successModelCalls.length).toBeGreaterThanOrEqual(1);
      const successSpansById = indexSpansById(successTrace);
      expect(successTerminal?.parentSpanId).toBeFalsy();
      for (const harness of successHarnesses) {
        expect(expectResolvedParent(harness, successSpansById)).toBe(successTerminal);
      }
      for (const run of successRuns) {
        expect(expectResolvedParent(run, successSpansById).name).toBe("openclaw.harness.run");
      }
      for (const modelCall of successModelCalls) {
        expect(expectResolvedParent(modelCall, successSpansById).name).toBe("openclaw.run");
      }
      expect(expectResolvedParent(successEvidence!, successSpansById).name).toBe("openclaw.run");
    } finally {
      await settleCleanup(
        async () => {
          await gateway?.stop();
        },
        async () => {
          await mock?.stop();
        },
        async () => {
          await receiver?.close();
        },
        async () => {
          await bus?.stop();
        },
      );
    }
  }, 120_000);
});
