// E2E: expired ask_user reservations must not suppress later prompts.
import { afterEach, describe, expect, it } from "vitest";
import {
  createAskUserTool,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "../src/agents/tools/ask-user-tool.js";
import { sendQuestionToolPrompt } from "../src/agents/tools/question-prompt-send.js";
import {
  createSecretsTool,
  normalizeSecretsRequestParams,
} from "../src/agents/tools/secrets-tool.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 120_000;
const instances: OpenClawTestInstance[] = [];
const askUserArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
});

describe("ask_user prompt expiry Gateway behavior", () => {
  it(
    "releases an expired reservation before the next question",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { client, sessionKey, reservation } = await createFixture("ask-user-prompt-expiry", 1);
      try {
        const questions = normalizeAskUserParams(askUserArgs).questions;
        const gatewayCalls: string[] = [];
        const gatewayCall = async (
          method: string,
          opts: { timeoutMs?: number },
          params?: unknown,
          extra?: { signal?: AbortSignal },
        ) => {
          gatewayCalls.push(method);
          return await client.request(method, params, {
            timeoutMs: opts.timeoutMs,
            signal: extra?.signal,
          });
        };
        const readiness = waitForAskUserPromptReady(reservation.questionId, gatewayCall);
        await expect(readiness).resolves.toBeUndefined();
        const delayedExecution = await createAskUserTool({ sessionKey, gatewayCall }).execute(
          reservation.toolCallId,
          askUserArgs,
        );

        expect(
          reserveAskUserPromptDelivery({
            toolCallId: "call-after-expiry",
            sessionKey,
            questions,
          }),
        ).toBeDefined();
        expect(delayedExecution).toMatchObject({ details: { status: "no_answer" } });
        expect(gatewayCalls).not.toContain("question.request");
        process.stderr.write(
          `ASK_USER_REAL_CLEANUP_PROOF ${JSON.stringify({
            readiness: "expired",
            reservationReleased: true,
            delayedExecution: "no_answer",
            questionRequestAfterExpiry: false,
            nextReservation: "accepted",
          })}\n`,
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );

  it(
    "keeps a renewed reservation ready after an older status read expires",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { client, reservation } = await createFixture("ask-user-prompt-renewal", 1);
      try {
        const questions = normalizeAskUserParams(askUserArgs).questions;
        let listCalls = 0;
        const gatewayCalls: string[] = [];
        const gatewayCall = async (
          method: string,
          opts: { timeoutMs?: number },
          params?: unknown,
          extra?: { signal?: AbortSignal },
        ) => {
          gatewayCalls.push(method);
          const result = await client.request(method, params, {
            timeoutMs: opts.timeoutMs,
            signal: extra?.signal,
          });
          if (method === "question.list" && ++listCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
          }
          return result;
        };
        const readiness = waitForAskUserPromptReady(reservation.questionId, gatewayCall);
        const execution = createAskUserTool({
          sessionKey: "agent:main:ask-user-prompt-renewal",
          gatewayCall,
        }).execute(reservation.toolCallId, { ...askUserArgs, timeoutSeconds: 30 });
        await expect
          .poll(() => gatewayCalls.includes("question.request"), { timeout: 5_000 })
          .toBe(true);

        const readyQuestions = await readiness;
        const listed = await client.request<{
          questions: Array<{ id: string; status: string }>;
        }>("question.list", {});
        const activeQuestion = listed.questions.find(({ id }) => id === reservation.questionId);
        await sendQuestionToolPrompt({
          toolName: "ask_user",
          questionId: reservation.questionId,
          questions,
          send: async () => undefined,
        });
        await client.request("question.resolve", {
          id: reservation.questionId,
          cancel: true,
          resolvedBy: "proof",
        });
        await expect(execution).resolves.toMatchObject({ details: { status: "no_answer" } });

        expect(readyQuestions).toEqual(questions);
        expect(activeQuestion).toMatchObject({ id: reservation.questionId, status: "pending" });
        process.stderr.write(
          `ASK_USER_REAL_RENEWAL_PROOF ${JSON.stringify({
            oldReadDeadline: "expired",
            renewedReservation: "ready",
            activeQuestionBeforeCancel: activeQuestion?.status ?? null,
            questionRequest: gatewayCalls.includes("question.request"),
            activeQuestionAfterCancel: null,
          })}\n`,
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );

  it(
    "rejects delayed credential execution after readiness cleanup",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const args = { action: "request", name: "SERVICE_API_KEY", kind: "secret" };
      const questions = normalizeSecretsRequestParams(args).questions;
      const { client, sessionKey, reservation } = await createFixture(
        "secrets-prompt-expiry",
        1,
        questions,
      );
      try {
        const gatewayCalls: string[] = [];
        const gatewayCall = async (
          method: string,
          opts: { timeoutMs?: number },
          params?: unknown,
          extra?: { signal?: AbortSignal },
        ) => {
          gatewayCalls.push(method);
          return await client.request(method, params, {
            timeoutMs: opts.timeoutMs,
            signal: extra?.signal,
          });
        };
        const readiness = waitForAskUserPromptReady(reservation.questionId, gatewayCall);
        await expect(readiness).resolves.toBeUndefined();
        const delayedExecution = await createSecretsTool({ sessionKey, gatewayCall }).execute(
          reservation.toolCallId,
          args,
        );

        expect(
          reserveAskUserPromptDelivery({
            toolCallId: "call-after-secret-expiry",
            sessionKey,
            questions,
          }),
        ).toBeDefined();
        expect(delayedExecution).toMatchObject({ details: { status: "no_answer" } });
        expect(gatewayCalls).not.toContain("question.request");
        process.stderr.write(
          `SECRETS_REAL_CLEANUP_PROOF ${JSON.stringify({
            readiness: "expired",
            delayedExecution: "no_answer",
            questionRequestAfterExpiry: false,
            nextReservation: "accepted",
          })}\n`,
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

async function createFixture(
  name: string,
  timeoutSeconds: number,
  questions = normalizeAskUserParams(askUserArgs).questions,
) {
  const instance = await createOpenClawTestInstance({
    name,
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  instances.push(instance);
  await instance.startGateway();
  const client = await connectGatewayClient({
    url: instance.url,
    token: instance.gatewayToken,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.questions"],
  });
  const sessionKey = `agent:main:${name}`;
  const toolCallId = `call-${name}`;
  const reservation = reserveAskUserPromptDelivery({
    toolCallId,
    sessionKey,
    questions,
    timeoutSeconds,
  });
  if (!reservation) {
    throw new Error("expected prompt reservation");
  }
  return { client, sessionKey, toolCallId, reservation: { ...reservation, toolCallId } };
}
