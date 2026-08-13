// Fake Codex app server used by media-path E2E scenarios.
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
  runFakeCodexAppServer,
} from "../codex-app-server-fixture.mjs";

const requestLog =
  process.env.OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG ??
  "/tmp/openclaw-codex-media-path-app-server.jsonl";
let turnCount = 0;

runFakeCodexAppServer({
  requestLog,
  handlers: {
    initialize: ({ sendResult }) =>
      sendResult(
        createFakeInitializeResponse({
          name: "openclaw-codex-media-path-e2e",
          version: "0.125.0",
          userAgent: "openclaw-codex-media-path-e2e/0.125.0 (Docker; test)",
        }),
      ),
    "thread/start": ({ params, sendResult }) =>
      sendResult(
        createFakeThreadStartResponse({
          params,
          threadId: "thread-codex-media-path-e2e",
          sessionId: "session-codex-media-path-e2e",
          version: "0.125.0",
        }),
      ),
    "turn/start": ({ sendResult }) => {
      turnCount += 1;
      sendResult({
        turn: {
          id: `turn-codex-media-path-e2e-${turnCount}`,
          status: "completed",
          items: [
            {
              type: "agentMessage",
              id: `msg-codex-media-path-e2e-${turnCount}`,
              text: "CODEX_MEDIA_PATH_E2E_OK",
            },
          ],
        },
      });
    },
  },
});
