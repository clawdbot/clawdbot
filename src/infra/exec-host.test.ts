// Covers exec host socket request signing and response handling.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestJsonlSocketMock = vi.hoisted(() => vi.fn());

vi.mock("./jsonl-socket.js", () => ({
  requestJsonlSocket: (...args: unknown[]) => requestJsonlSocketMock(...args),
}));

import { requestExecHostViaSocket } from "./exec-host.js";

type JsonlSocketCall = {
  socketPath: string;
  requestLine: string;
  timeoutMs: number;
  signal?: AbortSignal;
  accept: (msg: unknown) => unknown;
};

function requireJsonlSocketCall(): JsonlSocketCall {
  const call = requestJsonlSocketMock.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected requestJsonlSocket call");
  }
  return call as JsonlSocketCall;
}

describe("requestExecHostViaSocket", () => {
  beforeEach(() => {
    requestJsonlSocketMock.mockReset();
  });

  it("returns null when socket credentials are missing", async () => {
    await expect(
      requestExecHostViaSocket({
        socketPath: "",
        token: "secret",
        request: { command: ["echo", "hi"] },
      }),
    ).resolves.toBeNull();
    await expect(
      requestExecHostViaSocket({
        socketPath: "/tmp/socket",
        token: "",
        request: { command: ["echo", "hi"] },
      }),
    ).resolves.toBeNull();
    expect(requestJsonlSocketMock).not.toHaveBeenCalled();
  });

  it("signs only the exec request and forwards cancellation outside the envelope", async () => {
    requestJsonlSocketMock.mockResolvedValueOnce({ ok: true, payload: { success: true } });
    const controller = new AbortController();

    await expect(
      requestExecHostViaSocket({
        socketPath: "/tmp/socket",
        token: "secret",
        signal: controller.signal,
        request: {
          command: ["echo", "hi"],
          cwd: "/tmp",
        },
      }),
    ).resolves.toEqual({ ok: true, payload: { success: true } });

    const call = requireJsonlSocketCall();

    expect(call.socketPath).toBe("/tmp/socket");
    expect(call.timeoutMs).toBe(20_000);
    expect(call.signal).toBe(controller.signal);
    const payload = JSON.parse(call.requestLine) as {
      type: string;
      id: string;
      nonce: string;
      ts: number;
      hmac: string;
      requestJson: string;
    };
    expect(payload.type).toBe("exec");
    expect(payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof payload.ts).toBe("number");
    expect(Object.keys(payload).toSorted()).toEqual([
      "hmac",
      "id",
      "nonce",
      "requestJson",
      "ts",
      "type",
    ]);
    expect(payload.hmac).toBe(
      crypto
        .createHmac("sha256", "secret")
        .update(`${payload.nonce}:${payload.ts}:${payload.requestJson}`)
        .digest("hex"),
    );
    expect(JSON.parse(payload.requestJson)).toEqual({
      command: ["echo", "hi"],
      cwd: "/tmp",
    });
  });

  it("accepts only exec response messages and maps malformed matches to null", async () => {
    requestJsonlSocketMock.mockImplementationOnce(async ({ accept }) => {
      expect(accept({ type: "ignore" })).toBeUndefined();
      expect(accept({ type: "exec-res", ok: true, payload: { success: true } })).toEqual({
        ok: true,
        payload: { success: true },
      });
      expect(accept({ type: "exec-res", ok: false, error: { code: "DENIED" } })).toEqual({
        ok: false,
        error: { code: "DENIED" },
      });
      expect(accept({ type: "exec-res", ok: true })).toBeNull();
      return null;
    });

    await expect(
      requestExecHostViaSocket({
        socketPath: "/tmp/socket",
        token: "secret",
        timeoutMs: 123,
        request: { command: ["echo", "hi"] },
      }),
    ).resolves.toBeNull();

    expect(requireJsonlSocketCall().timeoutMs).toBe(123);
  });
});
