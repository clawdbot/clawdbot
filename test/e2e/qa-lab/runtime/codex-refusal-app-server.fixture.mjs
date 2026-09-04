// Deterministic Codex app-server fixture: refuse the first turn, complete the next.
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
  runFakeCodexAppServer,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";

const requestLog = process.env.OPENCLAW_QA_CODEX_REFUSAL_APP_SERVER_LOG;
const appServerVersion = process.env.OPENCLAW_QA_CODEX_APP_SERVER_VERSION;
if (!requestLog || !appServerVersion) {
  throw new Error("missing Codex refusal fixture environment");
}

const threadId = "thread-qa-codex-refusal";
let turnCount = 0;
let loaded = false;
const threadResponse = (params) =>
  createFakeThreadStartResponse({
    params,
    threadId,
    sessionId: "session-qa-codex-refusal",
    version: appServerVersion,
  });

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
      loaded = true;
      sendResult(threadResponse(params));
    },
    "thread/resume": ({ params, sendResult }) => {
      loaded = true;
      sendResult(threadResponse(params));
    },
    "thread/read": ({ sendResult }) => {
      const thread = threadResponse({}).thread;
      sendResult({ thread: { ...thread, status: { type: loaded ? "idle" : "notLoaded" } } });
    },
    "thread/unsubscribe": ({ notify, params, sendResult }) => {
      loaded = false;
      notify("thread/status/changed", {
        threadId: params?.threadId ?? threadId,
        status: { type: "notLoaded" },
      });
      sendResult({ status: "unsubscribed" });
    },
    "turn/start": ({ notify, sendResult }) => {
      turnCount += 1;
      const turnId = `turn-qa-codex-refusal-${turnCount}`;
      sendResult({
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setImmediate(() => {
        const completedAt = Math.floor(Date.now() / 1000);
        if (turnCount === 1) {
          const error = {
            message: "This content was flagged for possible biological risk. Synthetic detail.",
            codexErrorInfo: "other",
            additionalDetails: null,
          };
          notify("error", { threadId, turnId, error, willRetry: false });
          notify("turn/completed", {
            threadId,
            turn: {
              id: turnId,
              items: [],
              itemsView: "full",
              status: "failed",
              error,
              startedAt: completedAt,
              completedAt,
              durationMs: 0,
            },
          });
          return;
        }
        const message = {
          type: "agentMessage",
          id: `message-qa-codex-refusal-${turnCount}`,
          text: "QA_CODEX_LATER_TURN_OK",
        };
        notify("item/completed", { item: message, threadId, turnId, completedAtMs: Date.now() });
        notify("turn/completed", {
          threadId,
          turn: {
            id: turnId,
            items: [message],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: completedAt,
            completedAt,
            durationMs: 0,
          },
        });
      });
    },
  },
});
