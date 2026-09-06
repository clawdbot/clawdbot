// Deterministic native failures followed by an ordinary successful turn.
import { randomUUID } from "node:crypto";
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
  runFakeCodexAppServer,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";

const requestLog = process.env.OPENCLAW_QA_CODEX_REFUSAL_APP_SERVER_LOG;
const appServerVersion = process.env.OPENCLAW_QA_CODEX_APP_SERVER_VERSION;
const failureKind = process.env.OPENCLAW_QA_CODEX_FAILURE_KIND;
const failures = {
  bio: {
    message: "This content was flagged for possible biological risk. Synthetic detail.",
    codexErrorInfo: "other",
  },
  cyber: {
    message: "Synthetic provider cyber policy decision.",
    codexErrorInfo: "cyberPolicy",
  },
  misalignment: {
    message: "Synthetic misalignment policy decision: internal server error.",
    codexErrorInfo: "misalignmentPolicyViolation",
  },
  retryable: {
    message: "An error occurred while processing your request. Synthetic detail.",
    codexErrorInfo: "internalServerError",
  },
};
if (!requestLog || !appServerVersion || !Object.hasOwn(failures, failureKind)) {
  throw new Error("missing Codex refusal fixture environment");
}

const threads = new Map();
let turnCount = 0;

runFakeCodexAppServer({
  requestLog,
  logMode: "messages",
  handlers: {
    initialize: ({ sendResult }) =>
      sendResult(
        createFakeInitializeResponse({
          name: "openclaw-qa-codex-refusal",
          version: appServerVersion,
          userAgent: `openclaw/${appServerVersion} (test)`,
        }),
      ),
    "account/login/start": ({ params, sendResult }) => sendResult({ type: params?.type }),
    "account/rateLimits/read": ({ sendResult }) =>
      sendResult({
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      }),
    "account/read": ({ sendResult }) =>
      sendResult({
        account: { type: "chatgpt", email: "qa-refusal@example.test", planType: "pro" },
        requiresOpenaiAuth: true,
      }),
    "config/read": ({ sendResult }) => sendResult({ config: {}, origins: {}, layers: [] }),
    "configRequirements/read": ({ sendResult }) => sendResult({ requirements: null }),
    "thread/start": ({ params, sendResult }) => {
      const threadId = randomUUID();
      const response = createFakeThreadStartResponse({
        params,
        threadId,
        sessionId: randomUUID(),
        version: appServerVersion,
      });
      threads.set(threadId, response);
      sendResult(response);
    },
    "thread/resume": ({ params, sendResult }) => {
      sendResult(threads.get(params.threadId));
    },
    "thread/read": ({ params, sendResult }) => {
      sendResult({ thread: threads.get(params.threadId).thread });
    },
    "thread/unsubscribe": ({ sendResult }) => {
      // Native unsubscribe removes the listener; its loaded thread survives the
      // 30-minute idle-unload delay, including a completed systemError state.
      sendResult({ status: "unsubscribed" });
    },
    "turn/start": ({ notify, params, sendResult }) => {
      turnCount += 1;
      const attemptNumber = turnCount;
      const threadId = params.threadId;
      const thread = threads.get(threadId).thread;
      const turnId = randomUUID();
      const turn = {
        id: turnId,
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
        durationMs: null,
      };
      thread.turns.push(turn);
      thread.status = { type: "active", activeFlags: [] };
      sendResult({ turn });
      setImmediate(() => {
        notify("thread/status/changed", { threadId, status: thread.status });
        notify("turn/started", { threadId, turn });
        const completedAt = Math.floor(Date.now() / 1000);
        if (attemptNumber === 1) {
          const error = {
            ...failures[failureKind],
            additionalDetails: null,
            misalignment: null,
          };
          Object.assign(turn, { status: "failed", error, completedAt, durationMs: 0 });
          thread.status = { type: "systemError" };
          notify("thread/status/changed", { threadId, status: thread.status });
          notify("error", { threadId, turnId, error, willRetry: false });
          notify("turn/completed", { threadId, turn });
          return;
        }
        const message = {
          type: "agentMessage",
          id: randomUUID(),
          text: "QA_CODEX_LATER_TURN_OK",
        };
        notify("item/completed", { item: message, threadId, turnId, completedAtMs: Date.now() });
        Object.assign(turn, {
          items: [message],
          status: "completed",
          completedAt,
          durationMs: 0,
        });
        thread.status = { type: "idle" };
        notify("thread/status/changed", { threadId, status: thread.status });
        notify("turn/completed", { threadId, turn });
      });
    },
  },
});
