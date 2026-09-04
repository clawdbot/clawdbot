import {
  runAgentHarnessGatewayQuestion,
  type setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

const registrations = vi.hoisted(() => vi.fn());
type QuestionDispatcher = Extract<
  Parameters<typeof runAgentHarnessGatewayQuestion>[0]["gatewayCall"],
  { version: 2 }
>;

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    setActiveEmbeddedRun: (...args: Parameters<typeof actual.setActiveEmbeddedRun>) => {
      registrations(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

setupRunAttemptTestHooks();

describe("Codex source-bound pending input", () => {
  it.each(["open", "closed", "reassigned"] as const)(
    "guards a Codex pending-question claim across registration: %s",
    async (transition) => {
      registrations.mockClear();
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      let handle: Parameters<typeof setActiveEmbeddedRun>[1] | undefined;
      await vi.waitFor(() => {
        handle = registrations.mock.calls.findLast((call) => call[0] === params.sessionId)?.[1];
        expect(handle?.messageInjectionV2).toBeDefined();
      }, fastWait);
      const registration = createDeferred<void>();
      const registering = createDeferred<void>();
      const answer = createDeferred<Awaited<ReturnType<typeof runAgentHarnessGatewayQuestion>>>();
      const questionAbort = new AbortController();
      const gatewayCall = vi.fn(async (method: string, _options: unknown, raw: unknown) => {
        const input = raw as {
          id: string;
          answers?: { answers: Record<string, string[]> };
          cancel?: boolean;
        };
        if (method === "question.request") {
          registering.resolve();
          await registration.promise;
          return { id: input.id };
        }
        if (method === "question.waitAnswer") {
          return await answer.promise;
        }
        const result = input.cancel
          ? { status: "cancelled" as const }
          : { status: "answered" as const, answers: input.answers! };
        answer.resolve(result);
        return result;
      });
      const question = runAgentHarnessGatewayQuestion({
        sessionKey: params.sessionKey!,
        questions: [{ id: "mode", header: "Mode", question: "Continue?", options: [] }],
        timeoutMs: 60_000,
        gatewayCall: {
          version: 2,
          call: ({ method, options, params: requestParams, authority }) => {
            if (authority.kind === "source-bound") {
              authority.assertCurrent();
            }
            return gatewayCall(method, options, requestParams);
          },
        } satisfies QuestionDispatcher,
        delivery: {},
        signal: questionAbort.signal,
      });
      const questionOutcome = question.catch(() => undefined);
      try {
        await registering.promise;
        let sourceCurrent = true;
        const delivery = handle!
          .messageInjectionV2!.queueMessage(
            "controlled answer",
            { isInboundUserMessage: true },
            () => {
              if (!sourceCurrent) {
                throw new Error(
                  transition === "reassigned" ? "source claim replaced" : "source closed",
                );
              }
            },
            "source-bound",
          )
          .then(
            () => "accepted",
            () => "rejected",
          );
        sourceCurrent = transition === "open";
        registration.resolve();
        expect(await delivery).toBe(sourceCurrent ? "accepted" : "rejected");
        expect(
          gatewayCall.mock.calls.filter(([method]) => method === "question.resolve"),
        ).toHaveLength(sourceCurrent ? 1 : 0);
        expect(handle!.isAborted?.()).toBe(false);
        if (!sourceCurrent) {
          await handle!.messageInjectionV2!.queueMessage(
            "independent answer",
            { isInboundUserMessage: true },
            () => {},
            "source-bound",
          );
        }
        await expect(questionOutcome).resolves.toMatchObject({
          status: "answered",
          answers: {
            answers: { mode: [sourceCurrent ? "controlled answer" : "independent answer"] },
          },
        });
        expect(harness.requests.some(({ method }) => method === "turn/steer")).toBe(false);
        expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      } finally {
        registration.resolve();
        questionAbort.abort();
        await questionOutcome;
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
      }
    },
  );
});
