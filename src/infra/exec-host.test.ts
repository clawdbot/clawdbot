// Exercises the authenticated exec adapter without mocking the JSONL transport.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  requestExecHostViaSocket,
  type ExecHostRequest,
  type ExecHostResponse,
} from "./exec-host.js";
import { withJsonlSocketPeer } from "./jsonl-socket.test-support.js";

const execFileAsync = promisify(execFile);
const token = "exec-host-test-token";
const request: ExecHostRequest = {
  command: [process.execPath, "-e", 'process.stdout.write("executed")'],
  cwd: "/tmp",
  timeoutMs: 10_000,
};

function readSignedRequest(wire: string): { id: string; request: ExecHostRequest } {
  expect(wire.endsWith("\n")).toBe(true);
  expect(wire.trim().split("\n")).toHaveLength(1);
  const envelope = JSON.parse(wire) as {
    type: string;
    id: string;
    nonce: string;
    ts: number;
    hmac: string;
    requestJson: string;
  };
  expect(envelope.type).toBe("exec");
  expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(envelope.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(typeof envelope.ts).toBe("number");
  expect(Object.keys(envelope).toSorted()).toEqual([
    "hmac",
    "id",
    "nonce",
    "requestJson",
    "ts",
    "type",
  ]);
  expect(envelope.hmac).toBe(
    crypto
      .createHmac("sha256", token)
      .update(`${envelope.nonce}:${envelope.ts}:${envelope.requestJson}`)
      .digest("hex"),
  );
  return { id: envelope.id, request: JSON.parse(envelope.requestJson) as ExecHostRequest };
}

const responses: ExecHostResponse[] = [
  {
    ok: true,
    payload: { success: true, exitCode: 0, timedOut: false, stdout: "done", stderr: "" },
  },
  {
    ok: false,
    error: { code: "UNAVAILABLE", reason: "security=deny", message: "Denied by host policy" },
  },
];

describe.runIf(process.platform !== "win32")("requestExecHostViaSocket", () => {
  it("reports missing credentials and a missing socket as not-submitted without reaching a peer", async () => {
    await withJsonlSocketPeer(
      () => {
        throw new Error("Request must not be submitted");
      },
      async ({ dir, socketPath, connections }) => {
        for (const credentials of [
          { socketPath: "", token },
          { socketPath, token: "" },
          { socketPath: path.join(dir, "missing.sock"), token },
        ]) {
          await expect(
            requestExecHostViaSocket({ ...credentials, request, timeoutMs: 1_000 }),
          ).resolves.toEqual({ ok: false, error: "not-submitted" });
        }
        expect(connections).toHaveLength(0);
      },
    );
  });

  it.each(responses)(
    "preserves signed delivery and native response after half-close (ok=$ok)",
    async (response) => {
      await withJsonlSocketPeer(
        (socket, wire) => {
          const received = readSignedRequest(wire);
          expect(received.request).toEqual(request);
          socket.end(`${JSON.stringify({ type: "exec-res", id: received.id, ...response })}\n`);
        },
        async ({ socketPath }) => {
          await expect(
            requestExecHostViaSocket({
              socketPath,
              token,
              request,
              signal: new AbortController().signal,
              timeoutMs: 1_000,
            }),
          ).resolves.toEqual({ ok: true, value: response });
        },
      );
    },
  );

  it.each(["close", "malformed matching response", "timeout", "cancellation"] as const)(
    "never reports nonexecution when a completed command is followed by %s",
    async (fault) => {
      const controller = new AbortController();
      const order: string[] = [];
      await withJsonlSocketPeer(
        async (socket, wire) => {
          const received = readSignedRequest(wire);
          expect(received.request).toEqual(request);
          const [executable, ...argv] = received.request.command;
          assert.ok(executable, "Exec request must include an executable");
          const result = await execFileAsync(executable, argv, {
            cwd: received.request.cwd ?? undefined,
            env: { PATH: "/usr/bin:/bin" },
            timeout: 1_500,
          });
          expect(result.stdout).toBe("executed");
          order.push("executed");
          if (fault === "close") {
            socket.end();
          } else if (fault === "malformed matching response") {
            socket.end(`${JSON.stringify({ type: "exec-res", id: received.id, ok: true })}\n`);
          } else if (fault === "cancellation") {
            controller.abort();
          }
        },
        async ({ socketPath, requests }) => {
          const result = await requestExecHostViaSocket({
            socketPath,
            token,
            request,
            signal: controller.signal,
            timeoutMs: 2_000,
          });
          order.push("returned");
          expect(order).toEqual(["executed", "returned"]);
          expect(requests).toHaveLength(1);
          expect(result).toEqual({
            ok: false,
            error: fault === "cancellation" ? "cancelled" : "outcome-unknown",
          });
        },
      );
    },
  );
});
