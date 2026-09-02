// Covers submission certainty, request half-close, and cancellation over real sockets.
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import path from "node:path";
import timers from "node:timers";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { requestExecApprovalViaSocket } from "./exec-approvals-socket.js";
import { requestJsonlSocket } from "./jsonl-socket.js";
import { withJsonlSocketPeer } from "./jsonl-socket.test-support.js";

function acceptDoneValue(msg: unknown): number | null | undefined {
  const value = msg as { type?: string; value?: number };
  return value.type === "done" ? (value.value ?? null) : undefined;
}

const requestLine = '{"hello":"world"}';

describe.runIf(process.platform !== "win32")("requestJsonlSocket", () => {
  it("ignores malformed and unrelated lines and reads the reply after request half-close", async () => {
    await withJsonlSocketPeer(
      (socket, wire) => {
        expect(wire).toBe(`${requestLine}\n`);
        socket.end('{bad json}\n{"type":"ignore"}\n{"type":"done","value":42}\n');
      },
      async ({ socketPath }) => {
        const controller = new AbortController();
        await expect(
          requestJsonlSocket({
            socketPath,
            requestLine,
            timeoutMs: 1_000,
            accept: acceptDoneValue,
            signal: controller.signal,
          }),
        ).resolves.toEqual({ ok: true, value: 42 });
        expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      },
    );
  });

  it("reports a missing socket as not-submitted", async () => {
    await withTestDir({ prefix: "oc-js-", parentDir: "/tmp" }, async (dir) => {
      await expect(
        requestJsonlSocket({
          socketPath: path.join(dir, "missing.sock"),
          requestLine,
          timeoutMs: 1_000,
          accept: acceptDoneValue,
        }),
      ).resolves.toEqual({ ok: false, error: "not-submitted" });
    });
  });

  it("does not connect or send an already-cancelled request", async () => {
    const onRequest = vi.fn();
    await withJsonlSocketPeer(onRequest, async ({ socketPath, connections }) => {
      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine,
          timeoutMs: 1_000,
          accept: acceptDoneValue,
          signal: AbortSignal.abort(),
        }),
      ).resolves.toEqual({ ok: false, error: "cancelled" });
      expect(connections).toHaveLength(0);
      expect(onRequest).not.toHaveBeenCalled();
    });
  });

  it.each(["close", "malformed matching response", "timeout"] as const)(
    "reports outcome-unknown after submission followed by %s",
    async (fault) => {
      await withJsonlSocketPeer(
        (socket, wire) => {
          expect(wire).toBe(`${requestLine}\n`);
          if (fault === "close") {
            socket.end();
          } else if (fault === "malformed matching response") {
            socket.end('{"type":"done"}\n');
          }
        },
        async ({ socketPath, requests }) => {
          await expect(
            requestJsonlSocket({
              socketPath,
              requestLine,
              timeoutMs: 500,
              accept: acceptDoneValue,
            }),
          ).resolves.toEqual({ ok: false, error: "outcome-unknown" });
          expect(requests).toEqual([`${requestLine}\n`]);
        },
      );
    },
  );

  it("settles on socket close without waiting for the response deadline", async () => {
    await withJsonlSocketPeer(
      (socket) => {
        socket.destroy();
      },
      async ({ socketPath }) => {
        // Leave the deadline frozen: only the real socket close can settle this request.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const schedule = vi.spyOn(timers, "setTimeout").mockImplementation(setTimeout);
        const clear = vi.spyOn(timers, "clearTimeout").mockImplementation(clearTimeout);
        syncBuiltinESMExports();
        try {
          const pending = requestJsonlSocket({
            socketPath,
            requestLine,
            timeoutMs: 250,
            accept: () => undefined,
          });
          expect(vi.getTimerCount()).toBe(1);
          await expect(pending).resolves.toEqual({ ok: false, error: "outcome-unknown" });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          schedule.mockRestore();
          clear.mockRestore();
          vi.useRealTimers();
          syncBuiltinESMExports();
        }
      },
    );
  });

  it("cancels after submission without confusing cancellation with nonexecution", async () => {
    const received = createDeferredCore<Socket>();
    await withJsonlSocketPeer(
      (socket) => received.resolve(socket),
      async ({ socketPath }) => {
        const controller = new AbortController();
        const completed = vi.fn();
        const pending = requestJsonlSocket({
          socketPath,
          requestLine,
          timeoutMs: 5_000,
          accept: acceptDoneValue,
          signal: controller.signal,
        }).then(completed);
        try {
          const socket = await Promise.race([
            received.promise,
            pending.then(() => {
              throw new Error("Socket request settled before the peer received it");
            }),
          ]);
          expect(completed).not.toHaveBeenCalled();
          controller.abort();
          await pending;
          expect(completed).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "cancelled" });
          expect(getEventListeners(controller.signal, "abort")).toEqual([]);
          // Request EOF already arrived. EPIPE proves the response reader also closed.
          const writeError = vi.fn();
          socket.once("error", writeError);
          socket.write('{"type":"done","value":7}\n');
          await expect.poll(() => writeError.mock.calls.length).toBe(1);
          expect(writeError).toHaveBeenCalledWith(expect.objectContaining({ code: "EPIPE" }));
        } finally {
          controller.abort();
          await pending;
        }
      },
    );
  });
});

describe.runIf(process.platform !== "win32")("approval-only socket SDK contract", () => {
  it.each(["allow-once", "deny"] as const)(
    "still returns the bare %s decision",
    async (decision) => {
      await withJsonlSocketPeer(
        (socket, wire) => {
          const request = JSON.parse(wire) as { type: string; id: string; token: string };
          expect(request.type).toBe("request");
          expect(request.token).toBe("approval-test-token");
          socket.end(`${JSON.stringify({ type: "decision", id: request.id, decision })}\n`);
        },
        async ({ socketPath }) => {
          await expect(
            requestExecApprovalViaSocket({
              socketPath,
              token: "approval-test-token",
              request: { command: "example" },
              timeoutMs: 1_000,
            }),
          ).resolves.toBe(decision);
        },
      );
    },
  );

  it("keeps null for missing credentials, pre-send failure, and lost replies", async () => {
    await withJsonlSocketPeer(
      (socket) => {
        socket.end();
      },
      async ({ dir, socketPath }) => {
        for (const credentials of [
          { socketPath: "", token: "approval-test-token" },
          { socketPath, token: "" },
          { socketPath: path.join(dir, "missing.sock"), token: "approval-test-token" },
          { socketPath, token: "approval-test-token" },
        ]) {
          await expect(
            requestExecApprovalViaSocket({ ...credentials, request: {}, timeoutMs: 1_000 }),
          ).resolves.toBeNull();
        }
      },
    );
  });
});
