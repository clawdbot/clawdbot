import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSubscribedSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import { claimPendingAgentQuestionAnswer } from "../../agents/harness/gateway-question.js";
import { resetPendingAskUserQuestionsForTest } from "../../agents/tools/ask-user-tool.test-support.js";
import { createSecretsTool } from "../../agents/tools/secrets-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import { askUserMocks, hookMocks, mocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  globalBeforeAll0,
  describe0BeforeEach0,
  installThreadingTestPlugin,
  requireToolResultHandler,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

// Keep the routing fixture, but exercise the real prompt registry and readiness checks.
vi.unmock("../../agents/tools/ask-user-tool.js");
const gateway = vi.hoisted(() => vi.fn());
vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: gateway }));

beforeAll(globalBeforeAll0);
beforeEach(async () => {
  describe0BeforeEach0();
  const actual = await vi.importActual<typeof import("../../agents/tools/ask-user-tool.js")>(
    "../../agents/tools/ask-user-tool.js",
  );
  askUserMocks.isAskUserPromptPending.mockImplementation(actual.isAskUserPromptPending);
});
afterEach(() => resetPendingAskUserQuestionsForTest());

describe("credential prompt dispatch boundary", () => {
  it.each([
    {
      name: "quiet group link",
      link: true,
      route: false,
      failure: false,
      terminal: false,
      deny: false,
    },
    {
      name: "quiet group blocker",
      link: false,
      route: false,
      failure: false,
      terminal: false,
      deny: false,
    },
    { name: "routed link", link: true, route: true, failure: false, terminal: false, deny: false },
    {
      name: "routed blocker",
      link: false,
      route: true,
      failure: false,
      terminal: false,
      deny: false,
    },
    {
      name: "queued transport failure",
      link: true,
      route: false,
      failure: true,
      terminal: false,
      deny: false,
    },
    {
      name: "routed transport failure",
      link: true,
      route: true,
      failure: true,
      terminal: false,
      deny: false,
    },
    {
      name: "terminal before delivery",
      link: true,
      route: false,
      failure: false,
      terminal: true,
      deny: false,
    },
    {
      name: "explicit send-policy denial",
      link: true,
      route: false,
      failure: false,
      terminal: false,
      deny: true,
    },
  ])(
    "settles the producer's $name without plaintext controls",
    async ({ link, route, failure, terminal, deny }) => {
      setNoAbort();
      hookMocks.runner.hasHooks.mockReturnValue(false);
      installThreadingTestPlugin({ id: "telegram" });
      const answer = createDeferred<unknown>();
      const transport = createDeferred();
      const received = createDeferred<unknown>();
      const sessionKey = "agent:main:telegram:group:credential-proof";
      const runId = "credential-dispatch-run";
      const args = { action: "request", name: "SERVICE_API_KEY", kind: "secret" };
      let questionId = "";
      let questionStatus = "pending";
      gateway
        .mockReset()
        .mockImplementation(async (method: string, _opts: unknown, params: unknown) => {
          if (method === "question.request") {
            questionId = String(asNullableRecord(params)?.id);
            return { id: questionId };
          }
          if (method === "question.list") {
            return { questions: questionId ? [{ id: questionId, status: questionStatus }] : [] };
          }
          if (method === "question.waitAnswer") {
            return await answer.promise;
          }
          if (method === "question.resolve") {
            questionStatus = "cancelled";
            answer.resolve({ status: "cancelled" });
            return { ok: true };
          }
          throw new Error(`unexpected method ${method}`);
        });
      const deliver = vi.fn(async (payload: ReplyPayload, info: { kind: string }) => {
        if (info.kind !== "tool") {
          return;
        }
        received.resolve(payload);
        await transport.promise;
        if (failure) {
          throw new Error("transport failed");
        }
      });
      mocks.routeReply.mockImplementation(async (params: unknown) => {
        received.resolve(asNullableRecord(params)?.payload);
        await transport.promise;
        return failure
          ? { ok: false, delivered: false, error: "not delivered" }
          : { ok: true, delivered: true };
      });
      const cfg: OpenClawConfig = {
        gateway: link ? { publicOrigin: "https://console.example.test" } : {},
        ...(deny ? { session: { sendPolicy: { default: "deny" } } } : {}),
      };
      const dispatcher = createReplyDispatcher({ deliver });
      const progress = vi.fn();
      let toolOutcome: Promise<unknown> | undefined;
      let unsubscribe: (() => void) | undefined;
      let producerPayload: ReplyPayload | undefined;
      const callbackFinished = createDeferred();
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          SessionKey: sessionKey,
          Provider: route ? "webchat" : "telegram",
          Surface: "telegram",
          ChatType: "group",
          ...(route
            ? {
                OriginatingChannel: "telegram",
                OriginatingTo: "telegram:999",
                ExplicitDeliverRoute: true,
              }
            : {}),
        }),
        cfg,
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          suppressToolProgressMessages: true,
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onToolResult: progress,
        },
        replyResolver: async (_ctx, opts) => {
          const onToolResult = requireToolResultHandler(opts?.onToolResult);
          const harness = createSubscribedSessionHarness({
            runId,
            sessionKey,
            messageChannel: "telegram",
            config: cfg,
            onToolResult: async (payload) => {
              producerPayload = payload;
              if (terminal) {
                questionStatus = "cancelled";
              }
              try {
                await onToolResult(payload);
              } finally {
                callbackFinished.resolve();
              }
            },
          });
          unsubscribe = harness.subscription.unsubscribe;
          harness.emit({
            type: "tool_execution_start",
            toolName: "secrets",
            toolCallId: "credential-call",
            args,
          });
          toolOutcome = createSecretsTool({ sessionKey, runId, gatewayCall: gateway })
            .execute("credential-call", args)
            .then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            );
          await toolOutcome;
          return undefined;
        },
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(producerPayload).toBeDefined());
        if (terminal || deny) {
          transport.resolve();
          await callbackFinished.promise;
          expect(deliver).not.toHaveBeenCalled();
          expect(mocks.routeReply).not.toHaveBeenCalled();
          answer.resolve({ status: "cancelled" });
        } else {
          await vi.waitFor(() => expect(route ? mocks.routeReply : deliver).toHaveBeenCalledOnce());
          const payload = asNullableRecord(await received.promise);
          expect(payload?.channelData).toEqual({ askUser: { questionId } });
          expect(payload).not.toHaveProperty("presentation");
          expect(payload).not.toHaveProperty("interactive");
          expect(payload?.text).toContain(
            link
              ? `https://console.example.test/ask/${questionId}`
              : "Credential request unavailable here",
          );
          expect(questionStatus).toBe("pending");
          expect(gateway.mock.calls.some(([method]) => method === "question.resolve")).toBe(false);
          await expect(
            claimPendingAgentQuestionAnswer({ sessionKey, text: "not-a-credential" }),
          ).resolves.toBe(false);
          transport.resolve();
          await callbackFinished.promise;
          if (link && !failure) {
            answer.resolve({
              status: "answered",
              answers: { answers: { secret_value: ["stored"] } },
            });
            await expect(toolOutcome).resolves.toMatchObject({
              result: { details: { status: "stored" } },
            });
          } else {
            await expect(toolOutcome).resolves.toMatchObject({
              error: new Error("credential-request prompt delivery failed"),
            });
            expect(questionStatus).toBe("cancelled");
          }
        }
        expect(producerPayload).toBeDefined();
        expect(progress).not.toHaveBeenCalled();
        await expect(dispatch).resolves.toHaveProperty("result");
      } finally {
        transport.resolve();
        answer.resolve({ status: "cancelled" });
        await dispatch;
        unsubscribe?.();
      }
    },
  );
});
