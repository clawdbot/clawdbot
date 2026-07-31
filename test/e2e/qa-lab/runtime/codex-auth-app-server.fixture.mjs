// Minimal Codex app-server fixture for the QA auth product proof.
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
  runFakeCodexAppServer,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";

const requestLog = process.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG;
if (!requestLog) {
  throw new Error("missing OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG");
}

runFakeCodexAppServer({
  requestLog,
  logMode: "messages",
  handlers: {
    initialize: ({ sendResult }) =>
      sendResult(
        createFakeInitializeResponse({
          name: "openclaw-qa-codex-auth",
          version: "0.143.0",
          userAgent: "openclaw/0.143.0 (test)",
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
        account: {
          type: "chatgpt",
          email: "qa-codex-account@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      }),
    "thread/start": ({ params, sendResult }) =>
      sendResult(
        createFakeThreadStartResponse({
          params,
          threadId: "thread-qa-codex-auth",
          sessionId: "session-qa-codex-auth",
          version: "0.143.0",
        }),
      ),
    "turn/start": ({ notify, params, sendResult }) => {
      const threadId = params?.threadId ?? "thread-qa-codex-auth";
      const turnId = "turn-qa-codex-auth";
      const message = {
        type: "agentMessage",
        id: "message-qa-codex-auth",
        text: "QA_CODEX_AUTH_PRODUCT_PROOF_OK",
      };
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
        const completedAtMs = Date.now();
        notify("item/completed", {
          item: message,
          threadId,
          turnId,
          completedAtMs,
        });
        notify("turn/completed", {
          threadId,
          turn: {
            id: turnId,
            items: [message],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: Math.floor(completedAtMs / 1000),
            completedAt: Math.floor(completedAtMs / 1000),
            durationMs: 0,
          },
        });
      });
    },
  },
});
