/** Focused HTTP coverage for hook admission feedback and pending replay behavior. */
import { Agent, request as httpRequest } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "../infra/http-body.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const HOOK_TOKEN = "hook-secret";

afterEach(() => {
  drainSystemEvents(resolveMainSessionKeyFromConfig());
  vi.restoreAllMocks();
});

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HOOK_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function waitForCronIsolatedRuns(count: number): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
    .toBe(count);
}

function startAbortableHookRequest(
  port: number,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  const payload = JSON.stringify(body);
  let req!: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${HOOK_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Idempotency-Key": idempotencyKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
  return { response, abort: () => req.destroy() };
}
async function waitForDuplicateRequest(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
}

async function postOversizedChunkedHook(port: number): Promise<{
  statusCode: number | undefined;
  body: string;
  connection: string | undefined;
  events: string[];
}> {
  const agent = new Agent({ keepAlive: true });
  const events: string[] = [];
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          agent,
          host: "127.0.0.1",
          port,
          path: "/hooks/wake",
          method: "POST",
          headers: {
            Authorization: `Bearer ${HOOK_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            events.push("response-end");
            void socketClosed.then(() => {
              events.push("socket-close");
              resolve({
                statusCode: res.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
                connection: res.headers.connection,
                events,
              });
            }, reject);
          });
        },
      );
      const socketClosed = new Promise<void>((resolveClose) => {
        req.once("socket", (socket) => socket.once("close", resolveClose));
      });
      req.on("error", reject);
      req.setTimeout(5_000, () => req.destroy(new Error("chunked hook request timed out")));
      req.write('{"text":"');
      req.write("x".repeat(DEFAULT_WEBHOOK_MAX_BODY_BYTES + 1));
      req.end('"}');
    });
  } finally {
    agent.destroy();
  }
}

describe("gateway hook admission", () => {
  test("flushes an oversized chunked hook response before closing the socket", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const response = await postOversizedChunkedHook(port);

      expect(response).toEqual({
        statusCode: 413,
        body: JSON.stringify({ ok: false, error: "payload too large" }),
        connection: "close",
        events: ["response-end", "socket-close"],
      });
    });
  });

  test("rejects deferred wake delivery to an explicit session", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    };
    await withGatewayServer(async ({ port }) => {
      const response = await postHook(
        port,
        "/hooks/wake",
        { text: "Wake later", mode: "next-heartbeat", sessionKey: "hook:wake:later" },
        "deferred-custom-wake",
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "sessionKey requires mode=now",
      });
    });
  });

  test("real HTTP disconnect cancels queued admission but not accepted work", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    };
    await withGatewayServer(async ({ port }) => {
      const occupied = createDeferred();
      const targetQueued = createDeferred();
      const targetAborted = createDeferred();
      const accepted = createDeferred();
      const acceptedCompletion = createDeferred();
      const acceptedFinished = createDeferred();
      const mapSet = Reflect.get(Map.prototype, "set") as typeof Map.prototype.set;
      let queueEntries = 0;
      vi.spyOn(Map.prototype, "set").mockImplementation(
        function (this: Map<unknown, unknown>, key, value) {
          const result = Reflect.apply(mapSet, this, [key, value]);
          if (
            key === "agent:main:hook:proof:disconnect" &&
            value instanceof Promise &&
            ++queueEntries === 2
          ) {
            targetQueued.resolve();
          }
          return result;
        },
      );
      const abort = Reflect.get(
        AbortController.prototype,
        "abort",
      ) as typeof AbortController.prototype.abort;
      vi.spyOn(AbortController.prototype, "abort").mockImplementation(
        function (this: AbortController, reason) {
          Reflect.apply(abort, this, [reason]);
          const message =
            typeof reason === "object" && reason !== null && "message" in reason
              ? String(reason.message)
              : String(reason);
          if (message === "hook request disconnected") {
            targetAborted.resolve();
          }
        },
      );
      cronIsolatedRun.mockClear();
      cronIsolatedRun
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          await occupied.promise;
          return { status: "ok", summary: "blocker complete" };
        })
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          return { status: "ok", summary: "retry complete" };
        })
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          accepted.resolve();
          await acceptedCompletion.promise;
          acceptedFinished.resolve();
          return { status: "ok", summary: "accepted complete" };
        });
      const body = {
        message: "Proof dispatch",
        sessionKey: "hook:proof:disconnect",
        sessionMode: "persistent",
      };

      let abandoned: ReturnType<typeof startAbortableHookRequest> | undefined;
      let surviving: ReturnType<typeof startAbortableHookRequest> | undefined;
      try {
        const blocker = postHook(port, "/hooks/agent", body, "proof-blocker");
        await waitForCronIsolatedRuns(1);
        expect((await blocker).status).toBe(200);

        abandoned = startAbortableHookRequest(port, "/hooks/agent", body, "proof-stable-id");
        await targetQueued.promise;
        abandoned.abort();
        await expect(abandoned.response).rejects.toThrow();
        await targetAborted.promise;
        occupied.resolve();

        const retry = await postHook(port, "/hooks/agent", body, "proof-stable-id");
        expect(retry.status).toBe(200);
        await waitForCronIsolatedRuns(2);
        expect(cronIsolatedRun).toHaveBeenCalledTimes(2);

        surviving = startAbortableHookRequest(port, "/hooks/agent", body, "proof-accepted-id");
        void surviving.response.catch(() => undefined);
        await accepted.promise;
        surviving.abort();
        acceptedCompletion.resolve();
        await acceptedFinished.promise;
        expect(cronIsolatedRun).toHaveBeenCalledTimes(3);
        console.info(
          "GATEWAY_HTTP_PROOF",
          JSON.stringify({
            authenticated: true,
            stableIdempotencyKey: true,
            queuedByServerMapSignal: true,
            disconnectedByServerSignal: true,
            abandonedBeforeAdmission: true,
            abandonedExecutions: 0,
            retryExecutions: 1,
            acceptedDisconnectCompleted: true,
            acceptedExecutions: 1,
          }),
        );
      } finally {
        abandoned?.abort();
        surviving?.abort();
        occupied.resolve();
        acceptedCompletion.resolve();
      }
    });
  });

  test.each([
    {
      name: "direct",
      path: "/hooks/agent",
      body: { message: "Dispatch" },
      hooksConfig: { enabled: true, token: HOOK_TOKEN },
    },
    {
      name: "mapped",
      path: "/hooks/mapped-overlap",
      body: { subject: "Email" },
      hooksConfig: {
        enabled: true,
        token: HOOK_TOKEN,
        mappings: [
          {
            match: { path: "mapped-overlap" },
            action: "agent" as const,
            messageTemplate: "Mapped: {{payload.subject}}",
          },
        ],
      },
    },
  ])("keeps one $name pending replay alive when its creator disconnects", async (testCase) => {
    testState.hooksConfig = testCase.hooksConfig;
    await withGatewayServer(async ({ port }) => {
      const runnerAdmission = createDeferred();
      const duplicateFoundPending = createDeferred();
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
        await runnerAdmission.promise;
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });

      let creator: ReturnType<typeof startAbortableHookRequest> | undefined;
      try {
        creator = startAbortableHookRequest(
          port,
          testCase.path,
          testCase.body,
          `overlap-${testCase.name}`,
        );
        await waitForCronIsolatedRuns(1);
        const mapGet = Reflect.get(Map.prototype, "get") as typeof Map.prototype.get;
        vi.spyOn(Map.prototype, "get").mockImplementation(
          function (this: Map<unknown, unknown>, key) {
            const value = Reflect.apply(mapGet, this, [key]);
            if (
              typeof value === "object" &&
              value !== null &&
              "waiters" in value &&
              value.waiters === 1
            ) {
              duplicateFoundPending.resolve();
            }
            return value;
          },
        );

        const duplicate = postHook(port, testCase.path, testCase.body, `overlap-${testCase.name}`);
        await duplicateFoundPending.promise;
        creator.abort();
        await expect(creator.response).rejects.toThrow();
        runnerAdmission.resolve();

        expect((await duplicate).status).toBe(200);
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      } finally {
        creator?.abort();
        runnerAdmission.resolve();
      }
    });
  });

  test("shares one pending persistent dispatch without losing its session target", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    };
    await withGatewayServer(async ({ port }) => {
      const runnerAdmission = createDeferred();
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
        expect((params as { job?: { sessionTarget?: string } }).job?.sessionTarget).toBe(
          "session:hook:admission:shared",
        );
        await runnerAdmission.promise;
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });
      const request = () =>
        postHook(
          port,
          "/hooks/agent",
          {
            message: "Dispatch",
            sessionKey: "hook:admission:shared",
            sessionMode: "persistent",
          },
          "pending-persistent-idem",
        );

      const firstResponse = request();
      await waitForCronIsolatedRuns(1);
      const duplicateResponse = request();
      await waitForDuplicateRequest();
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      runnerAdmission.resolve();

      const [first, duplicate] = await Promise.all([firstResponse, duplicateResponse]);
      expect(first.status).toBe(200);
      expect(duplicate.status).toBe(200);
      const firstBody = (await first.json()) as { runId?: string };
      const duplicateBody = (await duplicate.json()) as { runId?: string };
      expect(duplicateBody.runId).toBe(firstBody.runId);
    });
  });

  test("shares one pending direct dispatch across simultaneous duplicates", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const runnerAdmission = createDeferred();
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
        await runnerAdmission.promise;
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });
      const request = () =>
        postHook(port, "/hooks/agent", { message: "Dispatch" }, "pending-direct-idem");

      const firstResponse = request();
      await waitForCronIsolatedRuns(1);
      const duplicateResponse = request();
      await waitForDuplicateRequest();
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      runnerAdmission.resolve();

      const [first, duplicate] = await Promise.all([firstResponse, duplicateResponse]);
      expect(first.status).toBe(200);
      expect(duplicate.status).toBe(200);
      const firstBody = (await first.json()) as { runId?: string };
      const duplicateBody = (await duplicate.json()) as { runId?: string };
      expect(duplicateBody.runId).toBe(firstBody.runId);
    });
  });

  test("shares one pending mapped dispatch across simultaneous duplicates", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "mapped-pending" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
        },
      ],
    };
    await withGatewayServer(async ({ port }) => {
      const runnerAdmission = createDeferred();
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
        await runnerAdmission.promise;
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });
      const request = () =>
        postHook(port, "/hooks/mapped-pending", { subject: "Email" }, "pending-mapped-idem");

      const firstResponse = request();
      await waitForCronIsolatedRuns(1);
      const duplicateResponse = request();
      await waitForDuplicateRequest();
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      runnerAdmission.resolve();

      const [first, duplicate] = await Promise.all([firstResponse, duplicateResponse]);
      expect(first.status).toBe(200);
      expect(duplicate.status).toBe(200);
      const firstBody = (await first.json()) as { runId?: string };
      const duplicateBody = (await duplicate.json()) as { runId?: string };
      expect(duplicateBody.runId).toBe(firstBody.runId);
    });
  });

  test("returns typed admission failures and leaves the idempotency key retryable", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun
        .mockResolvedValueOnce({
          status: "error",
          error: "session changed",
          admissionDisposition: "session-conflict",
        })
        .mockResolvedValueOnce({
          status: "error",
          error: "provider preparation failed",
          admissionDisposition: "rejected",
        })
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          return { status: "ok", summary: "done" };
        });
      const request = () =>
        postHook(port, "/hooks/agent", { message: "Dispatch" }, "admission-retry");

      const conflict = await request();
      expect(conflict.status).toBe(409);
      const conflictBody = (await conflict.json()) as { ok?: boolean; runId?: string };
      expect(conflictBody.ok).toBe(false);

      const gatewayFailure = await request();
      expect(gatewayFailure.status).toBe(502);
      const gatewayFailureBody = (await gatewayFailure.json()) as {
        ok?: boolean;
        runId?: string;
      };
      expect(gatewayFailureBody.ok).toBe(false);
      expect(gatewayFailureBody.runId).not.toBe(conflictBody.runId);

      const admitted = await request();
      expect(admitted.status).toBe(200);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(3);
    });
  });
});
