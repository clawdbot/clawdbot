// Delivered status tests cover persistence of cron delivery outcomes.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

import { sendGatewayCronWebhook } from "../gateway/server-cron-notifications.js";
import { runCronCommandJob } from "./command-runner.js";
import { CronService } from "./service.js";
import type { CronEvent } from "./service.js";
import {
  createFinishedBarrier,
  createStartedCronServiceWithFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { abortActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import type { CronServiceDeps } from "./service/state.js";
import type { CronDeliveryTrace } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

async function createHangingWebhookServer() {
  let resolveRequest!: (body: string) => void;
  const requestBody = new Promise<string>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((request) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolveRequest(body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    requestBody,
    webhookUrl: `http://127.0.0.1:${address.port}/hook`,
  };
}

async function closeWebhookServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function buildIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
  };
}

function buildAnnounceIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    ...buildIsolatedAgentTurnJob(name),
    delivery: { mode: "announce", channel: "forum", to: "123" },
  };
}

function buildWebhookIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    ...buildIsolatedAgentTurnJob(name),
    delivery: { mode: "webhook", to: "https://example.invalid/cron-completion" },
  };
}

function buildFailureDestinationOnlyJob(name: string): CronAddInput {
  return {
    ...buildIsolatedAgentTurnJob(name),
    delivery: {
      mode: "none",
      failureDestination: {
        mode: "webhook",
        to: "https://example.invalid/cron-failure",
      },
    },
  };
}

function buildBestEffortFailureDestinationOnlyJob(name: string): CronAddInput {
  return {
    ...buildFailureDestinationOnlyJob(name),
    delivery: {
      mode: "none",
      bestEffort: true,
      failureDestination: {
        mode: "webhook",
        to: "https://example.invalid/cron-failure",
      },
    },
  };
}

function buildMainSessionSystemEventJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
  };
}

function createIsolatedCronWithFinishedBarrier(params: {
  storePath: string;
  status?: "ok" | "error";
  delivered?: boolean;
  delivery?: CronDeliveryTrace;
  error?: string;
  deliveryError?: string;
  sendCronWebhook?: CronServiceDeps["sendCronWebhook"];
  onFinished?: (evt: {
    jobId: string;
    error?: string;
    delivered?: boolean;
    deliveryStatus?: string;
    deliveryError?: string;
    completionStatus?: string;
    failureNotificationDelivery?: {
      delivered?: boolean;
      status: string;
      error?: string;
    };
  }) => void;
}) {
  const finished = createFinishedBarrier();
  const cron = new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: params.status ?? ("ok" as const),
      summary: "done",
      ...(params.error === undefined ? {} : { error: params.error }),
      ...(params.deliveryError === undefined ? {} : { deliveryError: params.deliveryError }),
      ...(params.delivered === undefined ? {} : { delivered: params.delivered }),
      ...(params.delivery === undefined ? {} : { delivery: params.delivery }),
    })),
    sendCronWebhook: params.sendCronWebhook,
    onEvent: (evt) => {
      if (evt.action === "finished") {
        params.onFinished?.({
          jobId: evt.jobId,
          error: evt.error,
          delivered: evt.delivered,
          deliveryStatus: evt.deliveryStatus,
          deliveryError: evt.deliveryError,
          completionStatus: evt.completionStatus,
          failureNotificationDelivery: evt.failureNotificationDelivery,
        });
      }
      finished.onEvent(evt);
    },
  });
  return { cron, finished };
}

async function runSingleJobAndReadState(params: {
  cron: CronService;
  finished: ReturnType<typeof createFinishedBarrier>;
  job: CronAddInput;
  waitForFinished?: (jobId: string) => Promise<unknown>;
}) {
  const job = await params.cron.add(params.job);
  const finishedPromise = params.waitForFinished?.(job.id) ?? params.finished.waitForOk(job.id);
  vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
  await vi.runOnlyPendingTimersAsync();
  await finishedPromise;

  const jobs = await params.cron.list({ includeDisabled: true });
  return { job, updated: jobs.find((entry) => entry.id === job.id) };
}

function expectSuccessfulCronRun(
  updated:
    | {
        state: {
          lastStatus?: string;
          lastRunStatus?: string;
          [key: string]: unknown;
        };
      }
    | undefined,
) {
  expect(updated?.state.lastStatus).toBe("ok");
  expect(updated?.state.lastRunStatus).toBe("ok");
}

function expectDeliveryNotRequested(
  updated:
    | {
        state: {
          lastDelivered?: boolean;
          lastDeliveryStatus?: string;
          lastDeliveryError?: string;
          lastFailureNotificationDelivered?: boolean;
          lastFailureNotificationDeliveryStatus?: string;
          lastFailureNotificationDeliveryError?: string;
        };
      }
    | undefined,
) {
  expectSuccessfulCronRun(updated);
  expect(updated?.state.lastDelivered).toBeUndefined();
  expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
  expect(updated?.state.lastDeliveryError).toBeUndefined();
  expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
  expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
  expect(updated?.state.lastFailureNotificationDeliveryError).toBeUndefined();
}

async function runIsolatedJobAndReadState(params: {
  job: CronAddInput;
  status?: "ok" | "error";
  delivered?: boolean;
  delivery?: CronDeliveryTrace;
  error?: string;
  deliveryError?: string;
  sendCronWebhook?: CronServiceDeps["sendCronWebhook"];
  onFinished?: (evt: {
    jobId: string;
    error?: string;
    delivered?: boolean;
    deliveryStatus?: string;
    deliveryError?: string;
    completionStatus?: string;
    failureNotificationDelivery?: {
      delivered?: boolean;
      status: string;
      error?: string;
    };
  }) => void;
}) {
  const store = await makeStorePath();
  const finishedEvents = new Map<string, (evt: unknown) => void>();
  const { cron, finished } = createIsolatedCronWithFinishedBarrier({
    storePath: store.storePath,
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.delivered !== undefined ? { delivered: params.delivered } : {}),
    ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.deliveryError !== undefined ? { deliveryError: params.deliveryError } : {}),
    ...(params.sendCronWebhook !== undefined ? { sendCronWebhook: params.sendCronWebhook } : {}),
    onFinished: (evt) => {
      params.onFinished?.(evt);
      finishedEvents.get(evt.jobId)?.(evt);
    },
  });

  await cron.start();
  try {
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: params.job,
      waitForFinished: (jobId) =>
        new Promise((resolve) => {
          finishedEvents.set(jobId, resolve);
        }),
    });
    return updated;
  } finally {
    cron.stop();
  }
}

describe("CronService persists delivered status", () => {
  it("settles isolated-agent webhook delivery before recording the run", async () => {
    let finishedDeliveryStatus: string | undefined;
    const sendCronWebhook = vi.fn(async () => {});
    const updated = await runIsolatedJobAndReadState({
      job: buildWebhookIsolatedAgentTurnJob("webhook-delivered"),
      sendCronWebhook,
      onFinished: (event) => {
        finishedDeliveryStatus = event.deliveryStatus;
      },
    });

    expectSuccessfulCronRun(updated);
    expect(sendCronWebhook).toHaveBeenCalled();
    expect(updated?.state.lastDelivered).toBe(true);
    expect(updated?.state.lastDeliveryStatus).toBe("delivered");
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
    expect(finishedDeliveryStatus).toBe("delivered");
  });

  it.each([
    {
      name: "successful endpoint",
      responseStatus: 204,
      expectedStatus: "delivered",
      clockJumpMs: 0,
    },
    {
      name: "failing endpoint",
      responseStatus: 503,
      expectedStatus: "not-delivered",
      clockJumpMs: 0,
    },
    {
      name: "forward wall-clock jump",
      responseStatus: 204,
      expectedStatus: "delivered",
      clockJumpMs: 86_400_000,
    },
  ])(
    "records command webhook delivery through a real HTTP server: $name",
    async ({ responseStatus, expectedStatus, clockJumpMs }) => {
      const requests: string[] = [];
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push(body);
          response.writeHead(responseStatus, { Connection: "close" });
          response.end();
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      const webhookUrl = `http://127.0.0.1:${address.port}/hook`;
      const store = await makeStorePath();
      const finished = createFinishedBarrier();
      const started = createDeferred();
      const finish = createDeferred();
      let finishedEvent: CronEvent | undefined;
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runCommandJob: async ({ job, abortSignal }) => {
          if (clockJumpMs > 0) {
            started.resolve();
            await finish.promise;
            return { status: "ok", summary: "HOOKSCHED_PAYLOAD" };
          }
          return await runCronCommandJob({ job, abortSignal, nowMs: Date.now });
        },
        sendCronWebhook: async ({ event, abortSignal }) => {
          expect(abortSignal.aborted).toBe(false);
          const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
            signal: abortSignal,
          });
          if (!response.ok) {
            throw new Error(`Webhook request failed with HTTP ${response.status}`);
          }
        },
        onEvent: (event) => {
          if (event.action === "finished") {
            finishedEvent = event;
          }
          finished.onEvent(event);
        },
      });

      await cron.start();
      try {
        const job = await cron.add({
          name: `command webhook ${responseStatus}`,
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "command",
            argv: [process.execPath, "-e", "process.stdout.write('HOOKSCHED_PAYLOAD')"],
            ...(clockJumpMs > 0 ? { timeoutSeconds: 1 } : {}),
          },
          delivery: { mode: "webhook", to: webhookUrl },
        });
        const finishedPromise = finished.waitForOk(job.id);
        const run = cron.run(job.id, "force");
        if (clockJumpMs > 0) {
          await started.promise;
          vi.setSystemTime(Date.now() + clockJumpMs);
          finish.resolve();
        }
        await run;
        await finishedPromise;

        expect(requests).toHaveLength(1);
        expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({
          action: "finished",
          jobId: job.id,
          status: "ok",
          summary: "HOOKSCHED_PAYLOAD",
        });
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "ok",
          lastDeliveryStatus: expectedStatus,
          lastDelivered: responseStatus === 204,
        });
        expect(finishedEvent?.deliveryStatus).toBe(expectedStatus);
        if (responseStatus === 503) {
          expect(cron.getJob(job.id)?.state.lastDeliveryError).toContain("HTTP 503");
          expect(finishedEvent?.deliveryError).toContain("HTTP 503");
        }
      } finally {
        cron.stop();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    },
  );

  it("finalizes a hanging command webhook at the run deadline", async () => {
    const { server, requestBody, webhookUrl } = await createHangingWebhookServer();
    const store = await makeStorePath();
    let resolveFinished!: (event: CronEvent) => void;
    const finished = new Promise<CronEvent>((resolve) => {
      resolveFinished = resolve;
    });
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob: async ({ job, abortSignal }) =>
        await runCronCommandJob({ job, abortSignal, nowMs: Date.now }),
      sendCronWebhook: async ({ event, abortSignal }) => {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          signal: abortSignal,
        });
      },
      onEvent: (event) => {
        if (event.action === "finished") {
          resolveFinished(event);
        }
      },
    });

    await cron.start();
    try {
      const job = await cron.add({
        name: "command webhook deadline",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('HOOKSCHED_PAYLOAD')"],
          timeoutSeconds: 1,
        },
        delivery: { mode: "webhook", to: webhookUrl },
      });
      const runPromise = cron.run(job.id, "force");
      expect(JSON.parse(await requestBody)).toMatchObject({
        jobId: job.id,
        summary: "HOOKSCHED_PAYLOAD",
      });

      let settled = false;
      void finished.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const event = await finished;
      await runPromise;
      expect(event).toMatchObject({
        status: "ok",
        summary: "HOOKSCHED_PAYLOAD",
        delivered: false,
        deliveryStatus: "not-delivered",
      });
      expect(event.deliveryError).toContain("webhook delivery timed out");
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
      });
      expect(cron.getJob(job.id)?.state.lastDeliveryError).toContain("webhook delivery timed out");
      expect(cron.getJob(job.id)?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await closeWebhookServer(server);
    }
  });

  it("finalizes immediately when a command webhook is cancelled", async () => {
    vi.useRealTimers();
    const { server, requestBody, webhookUrl } = await createHangingWebhookServer();
    const store = await makeStorePath();
    let resolveFinished!: (event: CronEvent) => void;
    const finished = new Promise<CronEvent>((resolve) => {
      resolveFinished = resolve;
    });
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob: async ({ job, abortSignal }) =>
        await runCronCommandJob({ job, abortSignal, nowMs: Date.now }),
      sendCronWebhook: async ({ event, abortSignal }) => {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          signal: abortSignal,
        });
      },
      onEvent: (event) => {
        if (event.action === "finished") {
          resolveFinished(event);
        }
      },
    });

    await cron.start();
    try {
      const job = await cron.add({
        name: "command webhook cancellation",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('HOOKSCHED_PAYLOAD')"],
          timeoutSeconds: 0,
        },
        delivery: { mode: "webhook", to: webhookUrl },
      });
      const runPromise = cron.run(job.id, "force");
      await requestBody;

      const cancelledAt = performance.now();
      expect(abortActiveCronTaskRuns("Cancelled by operator.")).toBe(1);
      const event = await finished;
      expect(performance.now() - cancelledAt).toBeLessThan(1_000);
      await runPromise;

      expect(event).toMatchObject({
        status: "ok",
        summary: "HOOKSCHED_PAYLOAD",
        delivered: false,
        deliveryStatus: "not-delivered",
      });
      expect(event.deliveryError).toContain("webhook delivery cancelled");
      expect(event.deliveryError).toContain("Cancelled by operator.");
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
      });
      expect(cron.getJob(job.id)?.state.lastDeliveryError).toContain("webhook delivery cancelled");
      expect(cron.getJob(job.id)?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await closeWebhookServer(server);
    }
  });

  it("preserves Gateway-delivered when cancellation races with post-2xx cleanup", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(body);
        response.writeHead(200, {
          Connection: "close",
          "Content-Type": "text/plain",
        });
        response.flushHeaders();
        response.write("accepted");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const webhookUrl = `http://127.0.0.1:${address.port}/hook`;
    let resolveCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      resolveCleanupStarted = resolve;
    });
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async (value: unknown) => {
      const request = value as {
        url: string;
        init?: RequestInit;
        signal?: AbortSignal;
      };
      const response = await fetch(request.url, {
        ...request.init,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return {
        response,
        finalUrl: request.url,
        release: async () => {
          resolveCleanupStarted();
          await cleanup;
        },
      };
    });
    let resolveFinished!: (event: CronEvent) => void;
    const finished = new Promise<CronEvent>((resolve) => {
      resolveFinished = resolve;
    });
    const store = await makeStorePath();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "HOOKSCHED_PAYLOAD",
      })),
      sendCronWebhook: async (params) => await sendGatewayCronWebhook(params),
      onEvent: (event) => {
        if (event.action === "finished") {
          resolveFinished(event);
        }
      },
    });

    await cron.start();
    try {
      const job = await cron.add({
        name: "command webhook settled cancellation race",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "command", argv: ["ignored"] },
        delivery: { mode: "webhook", to: webhookUrl },
      });
      const runPromise = cron.run(job.id, "force");
      await cleanupStarted;
      expect(abortActiveCronTaskRuns("Cancelled after webhook acceptance.")).toBe(1);

      const event = await finished;
      resolveCleanup();
      await runPromise;
      expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({
        jobId: job.id,
        summary: "HOOKSCHED_PAYLOAD",
      });
      expect(event).toMatchObject({
        status: "ok",
        delivered: true,
        deliveryStatus: "delivered",
      });
      expect(event.deliveryError).toBeUndefined();
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDelivered: true,
        lastDeliveryStatus: "delivered",
      });
      expect(cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();
    } finally {
      resolveCleanup();
      cron.stop();
      await closeWebhookServer(server);
    }
  });

  it("persists lastDelivered=true when isolated job reports delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivered-true"),
      delivered: true,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(true);
    expect(updated?.state.lastDeliveryStatus).toBe("delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
  });

  it("persists lastDelivered=false when isolated job explicitly reports not delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivered-false"),
      delivered: false,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
  });

  it("preserves verified primary delivery when the isolated run later fails", async () => {
    let capturedEvent: { completionStatus?: string; deliveryError?: string } | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("verified-primary-before-error"),
      status: "error",
      delivered: true,
      delivery: {
        delivered: true,
        resolved: { ok: true, channel: "forum", to: "123" },
        messageToolSentTo: [{ channel: "forum", to: "123" }],
      },
      error: "provider failed after verified delivery",
      onFinished: (event) => (capturedEvent = event),
    });

    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.consecutiveErrors).toBeGreaterThan(0);
    expect(updated?.state.lastDelivered).toBe(true);
    expect(updated?.state.lastDeliveryStatus).toBe("delivered");
    expect(capturedEvent).toMatchObject({
      completionStatus: "failed",
      delivered: true,
      deliveryStatus: "delivered",
    });
    expect(updated?.state.lastDeliveryError ?? capturedEvent?.deliveryError).toBeUndefined();
  });

  it("does not infer scheduler alert delivery from a failed run result", async () => {
    let capturedEvent:
      | {
          delivered?: boolean;
          deliveryStatus?: string;
          failureNotificationDelivery?: {
            delivered?: boolean;
            status: string;
            error?: string;
          };
        }
      | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("error-notification-delivered"),
      status: "error",
      delivered: true,
      error: "Agent couldn't generate a response.",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBe("Agent couldn't generate a response.");
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
    expect(updated?.state.lastFailureNotificationDeliveryError).toBeUndefined();
    expect(capturedEvent?.delivered).toBe(false);
    expect(capturedEvent?.deliveryStatus).toBe("not-delivered");
    expect(capturedEvent?.failureNotificationDelivery).toBeUndefined();
  });

  it("persists scheduler-authorized alert intent as delivery unknown", async () => {
    let failureNotificationDelivery: { delivered?: boolean; status: string; error?: string };
    const job = buildAnnounceIsolatedAgentTurnJob("authorized-failure-notification");
    job.failureAlert = { after: 1 };

    const updated = await runIsolatedJobAndReadState({
      job,
      status: "error",
      error: "provider unavailable",
      onFinished: (event) => {
        failureNotificationDelivery = event.failureNotificationDelivery!;
      },
    });

    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");
    expect(updated?.state.lastFailureNotificationDeliveryError).toBeUndefined();
    expect(failureNotificationDelivery!).toEqual({ status: "unknown" });
  });

  it("keeps best-effort failure destinations suppressed", async () => {
    let capturedEvent:
      | {
          delivered?: boolean;
          deliveryStatus?: string;
          failureNotificationDelivery?: {
            delivered?: boolean;
            status: string;
            error?: string;
          };
        }
      | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildBestEffortFailureDestinationOnlyJob("best-effort-failure-destination-only"),
      status: "error",
      error: "Agent couldn't generate a response.",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
    expect(capturedEvent?.deliveryStatus).toBe("not-requested");
    expect(capturedEvent?.failureNotificationDelivery).toBeUndefined();
  });

  it("suppresses delivered=false when delivery.mode none opts out of delivery", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("delivery-none-delivered-false"),
      delivered: false,
      error: "Message failed",
    });
    expectDeliveryNotRequested(updated);
  });

  it("preserves delivery errors when requested delivery reports not delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivery-requested-error"),
      delivered: false,
      error: "Message failed",
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBe("Message failed");
  });

  it("persists not-requested delivery state when delivery is not configured", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("no-delivery"),
    });
    expectDeliveryNotRequested(updated);
  });

  it("persists unknown delivery state when delivery is requested but the runner omits delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivery-unknown"),
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBeUndefined();
    expect(updated?.state.lastDeliveryStatus).toBe("unknown");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("does not set lastDelivered for main session jobs", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: buildMainSessionSystemEventJob("main-session"),
    });

    expectDeliveryNotRequested(updated);
    expect(enqueueSystemEvent).toHaveBeenCalled();

    cron.stop();
  });

  it("emits delivered in the finished event", async () => {
    let capturedEvent: { jobId: string; delivered?: boolean; deliveryStatus?: string } | undefined;
    await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("event-test"),
      delivered: true,
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(capturedEvent?.delivered).toBe(true);
    expect(capturedEvent?.deliveryStatus).toBe("delivered");
  });

  it("surfaces a successful run's delivery error on the finished event", async () => {
    // Regression for https://github.com/openclaw/openclaw/issues/95419:
    // when an isolated turn succeeds but post-run delivery fails, the run keeps
    // `status: "ok"` (#94058) while the runner now reports the dispatch failure
    // on a dedicated `deliveryError` field. That diagnostic must travel through
    // service state -> the finished event -> persisted run history so the
    // CLI/UI/API run logs can show *why* delivery did not land, instead of the
    // failure being silently dropped because the run is not marked an error.
    let capturedEvent:
      | {
          jobId: string;
          error?: string;
          delivered?: boolean;
          deliveryStatus?: string;
          deliveryError?: string;
        }
      | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivery-error-readback"),
      status: "ok",
      delivered: false,
      deliveryError: "Message delivery failed",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    // The run itself succeeded: the run-level error stays empty so the run is
    // not mislabeled as a failure, while delivery is recorded as not-delivered
    // and `lastDeliveryError` carries the dispatch diagnostic.
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastError).toBeUndefined();
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBe("Message delivery failed");

    // The finished event mirrors the persisted state: it carries the delivery
    // error (the field the gateway forwards into the run log) without polluting
    // the run-level error.
    expect(capturedEvent?.error).toBeUndefined();
    expect(capturedEvent?.delivered).toBe(false);
    expect(capturedEvent?.deliveryStatus).toBe("not-delivered");
    expect(capturedEvent?.deliveryError).toBe("Message delivery failed");
  });

  it.each([
    {
      name: "required to best-effort",
      admittedBestEffort: false,
      edits: [true],
      expectedCompletionStatus: "failed",
    },
    {
      name: "default to required",
      admittedBestEffort: undefined,
      edits: [false],
      expectedCompletionStatus: "succeeded",
    },
    {
      name: "best-effort to required",
      admittedBestEffort: true,
      edits: [false],
      expectedCompletionStatus: "succeeded",
    },
    {
      name: "required A to B to A",
      admittedBestEffort: false,
      edits: [true, false],
      expectedCompletionStatus: "failed",
    },
  ])(
    "authors completion from the admitted delivery policy: $name",
    async ({ admittedBestEffort, edits, expectedCompletionStatus }) => {
      const store = await makeStorePath();
      const started = createDeferred();
      const finish = createDeferred<{
        status: "ok";
        delivered: false;
        deliveryError: string;
      }>();
      let finishedEvent: CronEvent | undefined;
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => {
          started.resolve();
          return await finish.promise;
        }),
        onEvent: (event) => {
          if (event.action === "finished") {
            finishedEvent = event;
          }
        },
      });
      await cron.start();
      const job = await cron.add({
        ...buildAnnounceIsolatedAgentTurnJob(`admitted-policy-${admittedBestEffort}`),
        delivery: {
          mode: "announce",
          channel: "forum",
          to: "123",
          ...(admittedBestEffort === undefined ? {} : { bestEffort: admittedBestEffort }),
        },
      });

      const run = cron.run(job.id, "force");
      await started.promise;
      for (const bestEffort of edits) {
        await cron.update(job.id, { delivery: { bestEffort } });
      }
      finish.resolve({
        status: "ok",
        delivered: false,
        deliveryError: "delivery rejected",
      });
      await run;

      expect(finishedEvent).toMatchObject({
        status: "ok",
        deliveryStatus: "not-delivered",
        completionStatus: expectedCompletionStatus,
      });
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        consecutiveErrors: 0,
      });
      cron.stop();
      await store.cleanup();
    },
  );
});
