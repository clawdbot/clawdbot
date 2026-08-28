import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createAcpSessionMeta } from "../auto-reply/reply/test-fixtures/acp-runtime.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { tryDispatchAcpReplyHook } from "../plugin-sdk/acpx.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

const runtime = vi.hoisted(() => ({
  runTurn: vi.fn(),
  rejectTranscript: false,
}));

vi.mock("../auto-reply/reply/dispatch-acp-transcript.runtime.js", async (importOriginal) => {
  const { persistAcpDispatchTranscript } =
    await importOriginal<typeof import("../auto-reply/reply/dispatch-acp-transcript.runtime.js")>();
  return {
    persistAcpDispatchTranscript: (params: Parameters<typeof persistAcpDispatchTranscript>[0]) =>
      runtime.rejectTranscript
        ? Promise.reject(new Error("transcript write rejected"))
        : persistAcpDispatchTranscript(params),
  };
});

vi.mock("../auto-reply/reply/dispatch-acp-manager.runtime.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: ({ sessionKey }: { sessionKey: string }) => ({
      kind: "ready",
      sessionKey,
      meta: createAcpSessionMeta({ agent: "main" }),
      entry: loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey,
        storePath: testState.sessionStorePath,
      }),
    }),
    runTurn: runtime.runTurn,
    getObservabilitySnapshot: () => ({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 1 },
    }),
  }),
  getSessionBindingService: () => ({ listBySession: () => [], unbind: async () => [] }),
}));

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readTranscriptMessages(scope: Parameters<typeof loadTranscriptEventsSync>[0]) {
  return loadTranscriptEventsSync(scope).flatMap((event) => {
    const entry = asOptionalRecord(event);
    const message = asOptionalRecord(entry?.message);
    return entry?.type === "message" && message ? [message] : [];
  });
}

describe("Gateway ACP completion ownership", () => {
  afterEach(() => {
    dispatchInboundMessageMock.mockReset();
    runtime.runTurn.mockReset();
    runtime.rejectTranscript = false;
    testState.sessionStorePath = undefined;
    vi.restoreAllMocks();
  });

  const cases: Array<{
    name: string;
    text?: string;
    transform?: (payload: ReplyPayload) => ReplyPayload | null;
    live?: boolean;
    bound?: boolean;
    media?: boolean;
    cancel?: boolean;
    rpcAbort?: boolean;
    rebound?: boolean;
    fail?: boolean;
    timeout?: boolean;
    persistFail?: boolean;
    suppressed?: boolean;
  }> = [
    { name: "cold and warm turns" },
    {
      name: "post-hook text",
      text: "rendered reply",
      transform: () => ({ text: "rendered reply" }),
    },
    { name: "post-hook suppression", suppressed: true, transform: () => null },
    { name: "live block replies", live: true },
    {
      name: "media on the owned row",
      media: true,
      transform: (payload) => ({ ...payload, mediaUrl: "https://example.test/photo.png" }),
    },
    {
      name: "bound target media",
      bound: true,
      media: true,
      transform: (payload) => ({ ...payload, mediaUrl: "https://example.test/photo.png" }),
    },
    { name: "runtime errors", fail: true },
    { name: "suppressed runtime errors", fail: true, transform: () => null },
    { name: "runtime timeout", timeout: true },
    { name: "suppressed runtime timeout", timeout: true, transform: () => null },
    { name: "persistence errors", persistFail: true },
    { name: "native cancellation", cancel: true },
    { name: "explicit abort", cancel: true, rpcAbort: true },
    {
      name: "persistence failure after explicit abort",
      cancel: true,
      rpcAbort: true,
      persistFail: true,
    },
    { name: "replaced transcript target", rebound: true },
  ];
  test.each(cases)("completes $name once with truthful transcript ownership", async (scenario) => {
    const storePath = path.join(tempDirs.make("openclaw-acp-completion-"), "sessions.json");
    testState.sessionStorePath = storePath;
    const mediaFile = path.join(path.dirname(storePath), "photo.png");
    if (scenario.media) {
      await fs.writeFile(
        mediaFile,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
          "base64",
        ),
      );
    }
    const suffix = scenario.name.replaceAll(" ", "-");
    const sessionKey = `agent:main:acp-completion-${suffix}`;
    const targetSessionKey = scenario.bound ? `agent:main:bound-${suffix}` : sessionKey;
    const sessionId = `acp-completion-session-${suffix}`;
    expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    let turnStarted = createDeferred();
    let releaseTurn = createDeferred();
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId: scenario.bound ? `source-${sessionId}` : sessionId,
          updatedAt: Date.now(),
          acp: createAcpSessionMeta({ agent: "main" }),
        },
        ...(scenario.bound
          ? {
              [targetSessionKey]: {
                sessionId,
                updatedAt: Date.now(),
                acp: createAcpSessionMeta({ agent: "main" }),
              },
            }
          : {}),
      },
    });
    runtime.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: AcpRuntimeEvent) => Promise<void> }) => {
        if (scenario.fail) {
          throw new Error("native turn failed");
        }
        if (scenario.timeout) {
          throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn timed out", {
            detailCode: "TURN_TIMEOUT",
          });
        }
        await onEvent({ type: "text_delta", text: "same accepted reply" });
        turnStarted.resolve();
        if (scenario.rpcAbort) {
          await releaseTurn.promise;
        }
        if (scenario.rebound) {
          await writeSessionStore({
            entries: {
              [targetSessionKey]: {
                sessionId: `${sessionId}-replaced-${runtime.runTurn.mock.calls.length}`,
                updatedAt: Date.now(),
                acp: createAcpSessionMeta({ agent: "main" }),
              },
            },
          });
        }
        await onEvent({ type: "done", status: scenario.cancel ? "cancelled" : "completed" });
      },
    );
    runtime.rejectTranscript = scenario.persistFail === true;
    const actualDispatch = await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
      "../auto-reply/dispatch.js",
    );
    dispatchInboundMessageMock.mockImplementation(async (input: unknown) => {
      // SAFETY: The Gateway mock adapter forwards the real dispatchInboundMessage parameters.
      const {
        ctx,
        cfg,
        dispatcher,
        replyOptions: inboundReplyOptions,
      } = input as Parameters<typeof dispatchInboundMessage>[0];
      return actualDispatch.dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: inboundReplyOptions,
        dispatchReplyFromConfig: async ({ ctx: finalized, replyOptions }) => {
          if (scenario.media) {
            dispatcher.appendBeforeDeliver?.((payload) => ({
              ...payload,
              mediaUrl: mediaFile,
              trustedLocalMedia: true,
            }));
          } else if (scenario.transform) {
            dispatcher.appendBeforeDeliver?.(scenario.transform);
          }
          const result = await tryDispatchAcpReplyHook(
            {
              ctx: finalized,
              runId: replyOptions?.runId,
              sessionKey: targetSessionKey,
              inboundAudio: false,
              shouldRouteToOriginating: false,
              shouldSendToolSummaries: false,
              shouldSendFullToolDetails: false,
              sendPolicy: "allow",
            },
            {
              ...replyOptions,
              cfg: {
                ...cfg,
                acp: {
                  enabled: true,
                  dispatch: { enabled: true },
                  ...(scenario.live ? { stream: { deliveryMode: "live" } } : {}),
                },
              },
              dispatcher,
              recordProcessed: () => {},
              markIdle: () => {},
            },
          );
          return result ?? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      });
    });
    const frames: Array<{
      event?: string;
      payload?: {
        runId?: string;
        state?: string;
        seq?: number;
        message?: unknown;
        reason?: string;
        stream?: string;
        data?: { phase?: string; reason?: string };
        errorKind?: string;
      };
    }> = [];
    const capture = (data: Buffer) => frames.push(JSON.parse(data.toString()));
    ws.on("message", capture);
    try {
      // Preserve the observed order: one cold turn, then the same session and
      // reply through the now-loaded lifecycle subscriber.
      for (const [index, temperature] of ["cold", "warm"].entries()) {
        const runId = `acp-completion-${suffix}-${temperature}`;
        turnStarted = createDeferred();
        releaseTurn = createDeferred();
        const expectedState = scenario.rpcAbort
          ? "aborted"
          : scenario.fail || scenario.persistFail || scenario.timeout || scenario.rebound
            ? "error"
            : scenario.cancel
              ? "aborted"
              : "final";
        const expectedStatus = scenario.rpcAbort
          ? "timeout"
          : scenario.fail || scenario.persistFail || scenario.rebound
            ? "error"
            : scenario.cancel || scenario.timeout
              ? "timeout"
              : "ok";
        const sendParameters = {
          sessionKey,
          message: `request ${temperature}`,
          idempotencyKey: runId,
        };
        const settled = onceMessage(
          ws,
          (frame) =>
            frame.event === "sessions.changed" &&
            frame.payload?.sessionKey === sessionKey &&
            frame.payload?.reason === "chat.run.settled",
        );
        const accepted = await rpcReq(ws, "chat.send", sendParameters);
        expect(accepted.ok).toBe(true);
        if (scenario.rpcAbort) {
          await turnStarted.promise;
          const aborted = await rpcReq(ws, "chat.abort", { sessionKey, runId });
          expect(aborted.payload).toMatchObject({ aborted: true, runIds: [runId] });
          releaseTurn.resolve();
        }
        // An abort can cache early. Require both replay and the public settled
        // notification before checking every competing completion frame.
        let replayPayload: unknown;
        await vi.waitFor(
          async () => {
            const replay = await rpcReq(ws, "chat.send", sendParameters);
            expect(replay.payload).toMatchObject({
              runId,
              status: expect.stringMatching(/^(ok|error|timeout)$/),
            });
            replayPayload = replay.payload;
          },
          { timeout: 10_000 },
        );
        await settled;
        expect.soft(replayPayload).toMatchObject({ runId, status: expectedStatus });
        if (scenario.cancel) {
          expect
            .soft(replayPayload)
            .toMatchObject({ summary: "aborted", endedAt: expect.any(Number) });
        }
        expect(runtime.runTurn).toHaveBeenCalledTimes(index + 1);
        const waited = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 5_000 });
        expect.soft(waited.payload).toMatchObject({
          status: scenario.cancel ? "error" : expectedStatus,
        });
        const finals = frames.filter(
          (frame) =>
            frame.event === "chat" &&
            frame.payload?.runId === runId &&
            ["final", "error", "aborted"].includes(frame.payload.state ?? ""),
        );
        expect.soft(finals, temperature).toHaveLength(1);
        expect.soft(finals[0]?.payload?.state).toBe(expectedState);
        const terminalIndex = frames.findIndex((frame) => frame === finals[0]);
        const priorSequence = Math.max(
          0,
          ...frames
            .slice(0, terminalIndex)
            .filter((frame) => frame.payload?.runId === runId)
            .map((frame) => frame.payload?.seq ?? 0),
        );
        expect.soft(finals[0]?.payload?.seq).toBeGreaterThan(priorSequence);
        if (scenario.timeout) {
          expect.soft(finals[0]?.payload?.errorKind).toBe("timeout");
        }
        if (expectedState !== "error" && !scenario.rpcAbort) {
          expect
            .soft(extractFirstTextBlock(finals[0]?.payload?.message), temperature)
            .toBe(scenario.suppressed ? undefined : (scenario.text ?? "same accepted reply"));
        }
        const lifecycle = frames.filter(
          (frame) =>
            frame.event === "agent" &&
            frame.payload?.runId === runId &&
            frame.payload.stream === "lifecycle",
        );
        expect
          .soft(lifecycle.map((frame) => frame.payload?.data?.phase))
          .toEqual(
            scenario.rpcAbort
              ? ["start", "end", scenario.persistFail ? "error" : "end"]
              : ["start", expectedState === "error" ? "error" : "end"],
          );
        expect
          .soft(
            frames.filter(
              (frame) =>
                frame.payload?.runId === runId && frame.payload?.data?.reason === "seq gap",
            ),
          )
          .toEqual([]);
        const messages = readTranscriptMessages({
          agentId: "main",
          sessionId: scenario.rebound ? `${sessionId}-replaced-${index + 1}` : sessionId,
          sessionKey: targetSessionKey,
          storePath,
        }).filter((message) => message.role === "user" || message.role === "assistant");
        expect
          .soft(
            messages.map((message) => message.role),
            temperature,
          )
          .toEqual(
            scenario.rebound || (scenario.rpcAbort && scenario.persistFail)
              ? []
              : Array.from({ length: index + 1 }, () =>
                  scenario.persistFail ? ["user"] : ["user", "assistant"],
                ).flat(),
          );
        if (scenario.media) {
          const assistant = messages.findLast((message) => message.role === "assistant");
          expect
            .soft(
              Array.isArray(assistant?.content) &&
                assistant.content.some((block: unknown) => {
                  const content = asOptionalRecord(block);
                  return content !== undefined && content.type !== "text";
                }),
            )
            .toBe(true);
        }
        if (scenario.bound) {
          expect
            .soft(
              readTranscriptMessages({
                agentId: "main",
                sessionId: `source-${sessionId}`,
                sessionKey,
                storePath,
              }),
            )
            .toEqual([]);
        }
      }
    } finally {
      releaseTurn.resolve();
      ws.off("message", capture);
    }
  });
});
