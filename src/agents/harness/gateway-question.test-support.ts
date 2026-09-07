import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocket, WebSocketServer } from "ws";
import type {
  QuestionRequestParams,
  QuestionResolveParams,
  QuestionWaitAnswerParams,
  RequestFrame,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { QuestionManager, QuestionManagerError } from "../../gateway/question-manager.js";
import { createDeferredCore as deferred, type Deferred } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
// Collect the real transport before test deadlines; production still imports it lazily.
export { callGatewayTool } from "../tools/gateway.js";

// Only the peer is synthetic: question claims use the production tool, one-shot
// call, client, and WebSocket send, with real QuestionManager terminal state.
export async function withQuestionGateway(
  run: (fixture: {
    manager: QuestionManager;
    backingRun: AbortController;
    requests: RequestFrame[];
    waitStarted: Promise<void>;
    holdNextHello: () => { entered: Promise<void>; release: () => void; fail: () => void };
    onResolved: (callback: () => void) => void;
    dropNextResolveResponse: () => void;
    holdRegistration: () => { entered: Promise<void>; release: () => void };
    holdWaitAnswerResponse: () => {
      entered: Promise<void>;
      release: () => void;
      fail: () => void;
    };
  }) => Promise<void>,
) {
  await withEnvAsync(
    {
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
    async () => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (typeof address === "string" || address === null || address.port === 18789) {
        throw new Error("expected an isolated question Gateway port");
      }
      setRuntimeConfigSnapshot({
        gateway: {
          mode: "local",
          port: address.port,
          auth: { mode: "token", token: "synthetic-question-test" },
        },
      });
      const manager = new QuestionManager();
      const backingRun = new AbortController();
      const requests: RequestFrame[] = [];
      const waitStarted = deferred();
      let nextHello: { entered: Deferred; release: Deferred<"allow" | "close"> } | undefined;
      let onResolved = () => {};
      let dropResolveResponse = false;
      let registrationHold: { entered: Deferred; release: Deferred } | undefined;
      let answerHold: { entered: Deferred; release: Deferred<boolean> } | undefined;
      server.on("connection", (socket) => {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "synthetic-question-nonce", ts: Date.now() },
          }),
        );
        socket.on("message", (raw) => {
          const frame = JSON.parse(rawDataToString(raw)) as RequestFrame;
          const respond = (payload: unknown) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
            }
          };
          if (frame.method === "connect") {
            const hold = nextHello;
            nextHello = undefined;
            hold?.entered.resolve();
            void (hold?.release.promise ?? Promise.resolve("allow")).then((outcome) => {
              if (outcome === "close") {
                socket.terminate();
              } else {
                respond({ type: "hello-ok" });
              }
            });
            return;
          }
          requests.push(frame);
          try {
            if (frame.method === "question.request") {
              const request = frame.params as QuestionRequestParams;
              const record = manager.request({
                ...request,
                timeoutMs: request.timeoutMs ?? 60_000,
                isRequesterActive: () => !backingRun.signal.aborted,
              });
              registrationHold?.entered.resolve();
              void (registrationHold?.release.promise ?? Promise.resolve()).then(() =>
                respond(record),
              );
            } else if (frame.method === "question.waitAnswer") {
              const request = frame.params as QuestionWaitAnswerParams;
              void manager
                .waitAnswer(request.id, undefined, request.includeResolutionId)
                .then(async (result) => {
                  answerHold?.entered.resolve();
                  if ((await answerHold?.release.promise) === false) {
                    socket.terminate();
                  } else {
                    respond(result);
                  }
                });
              waitStarted.resolve();
            } else if (frame.method === "question.resolve") {
              const request = frame.params as QuestionResolveParams;
              const result =
                "cancel" in request
                  ? manager.cancel(request.id, request.resolvedBy)
                  : manager.resolve(request.id, request.answers, request.resolvedBy, {
                      resolutionId: request.resolutionId,
                    });
              onResolved();
              if (dropResolveResponse) {
                dropResolveResponse = false;
                socket.terminate();
              } else {
                respond(result);
              }
            } else if (frame.method === "question.list") {
              respond({ questions: manager.list() });
            } else {
              throw new Error(`unexpected question fixture RPC: ${frame.method}`);
            }
          } catch (error) {
            if (!(error instanceof QuestionManagerError)) {
              throw error;
            }
            socket.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: {
                  code: "INVALID_REQUEST",
                  message: error.message,
                  details: { reason: error.code },
                },
              }),
            );
          }
        });
      });
      try {
        await run({
          manager,
          backingRun,
          requests,
          waitStarted: waitStarted.promise,
          holdNextHello: () => {
            const hold = { entered: deferred(), release: deferred<"allow" | "close">() };
            nextHello = hold;
            return {
              entered: hold.entered.promise,
              release: () => hold.release.resolve("allow"),
              fail: () => hold.release.resolve("close"),
            };
          },
          holdRegistration: () => {
            const hold = { entered: deferred(), release: deferred() };
            registrationHold = hold;
            return { entered: hold.entered.promise, release: () => hold.release.resolve() };
          },
          holdWaitAnswerResponse: () => {
            const hold = { entered: deferred(), release: deferred<boolean>() };
            answerHold = hold;
            return {
              entered: hold.entered.promise,
              release: () => hold.release.resolve(true),
              fail: () => hold.release.resolve(false),
            };
          },
          onResolved: (callback) => {
            onResolved = callback;
          },
          dropNextResolveResponse: () => {
            dropResolveResponse = true;
          },
        });
      } finally {
        manager.reset();
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        resetConfigRuntimeState();
      }
    },
  );
}
