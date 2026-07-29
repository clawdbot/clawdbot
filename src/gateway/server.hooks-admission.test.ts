/** Focused HTTP coverage for hook admission feedback and replay behavior. */
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
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

function createDeferred<T>() {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = (value) => innerResolve(value as T);
  });
  return { promise, resolve };
}

async function waitForDuplicateRequest(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
}

describe("gateway hook admission", () => {
  test("shares one pending direct dispatch across simultaneous duplicates", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const runnerAdmission = createDeferred<void>();
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

  test("evicts failed pending admission so a duplicate can retry", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const failedAdmission = createDeferred<void>();
      cronIsolatedRun.mockClear();
      cronIsolatedRun
        .mockImplementationOnce(async () => {
          await failedAdmission.promise;
          return {
            status: "error",
            summary: 'Session "agent:main:hook:pending-retry" changed while starting work. Retry.',
          };
        })
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          return { status: "ok", summary: "done" };
        });
      const request = () =>
        postHook(port, "/hooks/agent", { message: "Dispatch" }, "failed-pending-direct-idem");

      const firstResponse = request();
      await waitForCronIsolatedRuns(1);
      const duplicateResponse = request();
      await waitForDuplicateRequest();
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      failedAdmission.resolve();

      const [first, duplicate] = await Promise.all([firstResponse, duplicateResponse]);
      expect(first.status).toBe(409);
      expect(duplicate.status).toBe(409);
      const firstBody = (await first.json()) as { runId?: string };
      const duplicateBody = (await duplicate.json()) as { runId?: string };
      expect(duplicateBody.runId).toBe(firstBody.runId);

      const retry = await request();
      expect(retry.status).toBe(200);
      const retryBody = (await retry.json()) as { runId?: string };
      expect(retryBody.runId).not.toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
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
      const runnerAdmission = createDeferred<void>();
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

  test("returns admission failures and leaves the idempotency key retryable", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun
        .mockResolvedValueOnce({
          status: "error",
          summary: 'Session "agent:main:hook:conflict" changed while starting work. Retry.',
        })
        .mockResolvedValueOnce({
          status: "error",
          summary: "provider preparation failed",
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
