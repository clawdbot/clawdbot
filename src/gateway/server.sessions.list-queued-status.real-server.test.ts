// Real dev-Gateway proof that `sessions_list` accepts the Gateway's `queued`
// lifecycle status.
//
// Unlike the handler-level tests in server.sessions.list-queued-status.test.ts,
// this boots a real loopback Gateway server and drives it over a real WebSocket:
// `chat.send` admits a run whose reply backend never starts executing (it stays
// pending until we settle it), so the Gateway's own lifecycle reports the row as
// `queued`, and `sessions.list` over that same WebSocket surfaces it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import {
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  startConnectedServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";

type WireFrame = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: Record<string, unknown> | null;
  error?: { code?: string; message?: string };
};

type SessionsRow = { key?: string; status?: string; hasActiveRun?: boolean };

// Establishes the gateway test environment (config home, hooks, cleanup).
setupGatewaySessionsHandlerTestHarness();

test("real gateway reports an admitted-but-not-started run as queued through sessions.list", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-queued-real-"));
  const sessionId = "sess-queued-real";
  let started:
    | { ws: WebSocket; port: number; server: { close: () => Promise<void> } }
    | undefined;
  try {
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId,
          sessionFile: path.join(dir, `${sessionId}.jsonl`),
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = (started = await startConnectedServerWithClient());
    const { promise: replySettled, resolve: settleReply } = defer<string>();

    // chat.send admits the turn; the reply backend stays pending (never starts
    // executing), so the run's lifecycle reports `queued` until we settle it.
    mockGetReplyFromConfigOnce(async () => replySettled);

    const send = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "real gateway queued proof",
      idempotencyKey: "real-queued-run",
    });
    expect(send.ok, JSON.stringify(send.error)).toBe(true);

    const listPromise = onceMessage<WireFrame>(
      ws,
      (frame) => frame.type === "res" && frame.id === "real-queued-list",
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "real-queued-list",
        method: "sessions.list",
        params: {},
      }),
    );
    const res = await listPromise;
    const sessions = ((res.payload ?? {}) as { sessions?: SessionsRow[] }).sessions ?? [];
    const row = sessions.find((row) => row.key === "agent:main:main");

    expect(row?.status).toBe("queued");
    expect(row?.hasActiveRun).toBe(true);

    // Settle the pending reply so the run drains cleanly before teardown.
    settleReply('{ "text": "done" }');
    await replySettled.catch(() => undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await started?.server.close().catch(() => undefined);
  }
});

function defer<T = unknown>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
