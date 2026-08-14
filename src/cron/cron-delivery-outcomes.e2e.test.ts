import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
  sendGatewayCronWebhook,
} from "../gateway/server-cron-notifications.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCronCommandJob } from "./command-runner.js";
import { resolveCronDeliveryPreviews } from "./delivery-preview.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

type WebhookRequest = {
  body: Record<string, unknown>;
  path: string;
};

async function createWebhookReceiver(): Promise<{
  close: () => Promise<void>;
  request: Promise<WebhookRequest>;
  url: string;
}> {
  let resolveRequest!: (request: WebhookRequest) => void;
  const request = new Promise<WebhookRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      body += chunk;
    });
    incoming.on("end", () => {
      resolveRequest({
        body: JSON.parse(body) as Record<string, unknown>,
        path: incoming.url ?? "",
      });
      response.writeHead(204, { Connection: "close" });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    request,
    url: `http://127.0.0.1:${address.port}/cron`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function commandRunner(): NonNullable<CronServiceDeps["runCommandJob"]> {
  return async ({ job, abortSignal }) =>
    await runCronCommandJob({ job, abortSignal, nowMs: Date.now });
}

function historyEntry(storePath: string, jobId: string) {
  const history = readCronTaskRunHistoryPage({
    storeKey: cronStoreKey(storePath),
    jobId,
    limit: 1,
  });
  expect(history.total).toBe(1);
  return history.entries[0];
}

async function persistedJob(storePath: string, jobId: string) {
  return (await loadCronStore(storePath)).jobs.find((job) => job.id === jobId);
}

describe.sequential("cron delivery outcomes", () => {
  it("delivers a command result through the guarded webhook boundary and persists it", async () => {
    const receiver = await createWebhookReceiver();
    try {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-webhook-delivery-" },
        async (state) => {
          resetTaskRegistryForTests({ persist: false });
          const storePath = state.path("cron", "jobs.json");
          const cron = new CronService({
            storePath,
            cronEnabled: true,
            log: createNoopLogger(),
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runCommandJob: commandRunner(),
            runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
            sendCronWebhook: async (params) =>
              await sendGatewayCronWebhook({
                ...params,
                ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
              }),
          });
          try {
            await cron.start();
            const job = await cron.add({
              name: "primary webhook delivery",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: {
                kind: "command",
                argv: [process.execPath, "-e", "process.stdout.write('DELIVERY_OUTCOME')"],
              },
              delivery: { mode: "webhook", to: receiver.url },
            });

            await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
            const delivered = await receiver.request;
            expect(delivered).toMatchObject({
              path: "/cron",
              body: {
                action: "finished",
                jobId: job.id,
                status: "ok",
                summary: "DELIVERY_OUTCOME",
              },
            });
            expect(await persistedJob(storePath, job.id)).toMatchObject({
              state: {
                lastRunStatus: "ok",
                lastDelivered: true,
                lastDeliveryStatus: "delivered",
              },
            });
            expect(historyEntry(storePath, job.id)).toMatchObject({
              status: "ok",
              deliveryStatus: "delivered",
              delivered: true,
            });
          } finally {
            cron.stop();
            resetTaskRegistryForTests({ persist: false });
          }
        },
      );
    } finally {
      await receiver.close();
    }
  });

  it("dispatches a failed run to its real failure webhook and keeps durable error state", async () => {
    const receiver = await createWebhookReceiver();
    try {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-failure-destination-" },
        async (state) => {
          resetTaskRegistryForTests({ persist: false });
          const storePath = state.path("cron", "jobs.json");
          const cron = new CronService({
            storePath,
            cronEnabled: true,
            log: createNoopLogger(),
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runCommandJob: commandRunner(),
            runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
            onEvent: (event) => {
              if (event.action !== "finished") {
                return;
              }
              dispatchGatewayCronFinishedNotifications({
                evt: event,
                job: event.job ?? cron.getJob(event.jobId),
                deps: {} as never,
                logger: createNoopLogger(),
                resolveCronAgent: () => ({ agentId: "main", cfg: {} as never }),
                ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
              });
            },
          });
          try {
            await cron.start();
            const job = await cron.add({
              name: "failure destination delivery",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: {
                kind: "command",
                argv: [
                  process.execPath,
                  "-e",
                  "process.stderr.write('DELIVERY_FAILURE'); process.exit(2)",
                ],
              },
              delivery: {
                mode: "none",
                failureDestination: { mode: "webhook", to: receiver.url },
              },
            });

            await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
            expect(await receiver.request).toMatchObject({
              path: "/cron",
              body: {
                jobId: job.id,
                jobName: "failure destination delivery",
                status: "error",
                message:
                  'Automation "failure destination delivery" failed: command exited with code 2',
              },
            });
            expect(await persistedJob(storePath, job.id)).toMatchObject({
              state: {
                lastRunStatus: "error",
                lastError: "command exited with code 2",
              },
            });
            expect(historyEntry(storePath, job.id)).toMatchObject({
              status: "error",
              error: "command exited with code 2",
            });
          } finally {
            cron.stop();
            resetTaskRegistryForTests({ persist: false });
          }
        },
      );
    } finally {
      await receiver.close();
    }
  });

  it("sends skipped-run alerts through the real webhook path and persists alert state", async () => {
    const receiver = await createWebhookReceiver();
    try {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-skipped-alert-" },
        async (state) => {
          resetTaskRegistryForTests({ persist: false });
          const storePath = state.path("cron", "jobs.json");
          const cron = new CronService({
            storePath,
            cronEnabled: true,
            cronConfig: {
              failureAlert: {
                enabled: true,
                after: 1,
                cooldownMs: 0,
                includeSkipped: true,
                mode: "webhook",
                to: receiver.url,
              },
            },
            log: createNoopLogger(),
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runIsolatedAgentJob: vi.fn(async () => ({
              status: "skipped" as const,
              error: "requests-in-flight",
            })),
            sendCronFailureAlert: async (params) =>
              await sendGatewayCronFailureAlert({
                ...params,
                deps: {} as never,
                logger: createNoopLogger(),
                resolveCronAgent: () => ({ agentId: "main", cfg: {} as never }),
                ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
              }),
          });
          try {
            await cron.start();
            const job = await cron.add({
              name: "skipped run alert",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "check availability" },
              delivery: { mode: "none" },
            });

            await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
            expect(await receiver.request).toMatchObject({
              path: "/cron",
              body: {
                jobId: job.id,
                jobName: "skipped run alert",
                message:
                  'Automation "skipped run alert" skipped 1 times\nSkip reason: requests-in-flight',
              },
            });
            expect(await persistedJob(storePath, job.id)).toMatchObject({
              state: {
                lastRunStatus: "skipped",
                consecutiveSkipped: 1,
                lastFailureAlertAtMs: expect.any(Number),
              },
            });
            expect(historyEntry(storePath, job.id)).toMatchObject({
              status: "skipped",
              error: "requests-in-flight",
            });
          } finally {
            cron.stop();
            resetTaskRegistryForTests({ persist: false });
          }
        },
      );
    } finally {
      await receiver.close();
    }
  });

  it("builds delivery previews from persisted webhook and opt-out jobs", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-delivery-preview-" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        const cron = new CronService({
          storePath: state.path("cron", "jobs.json"),
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runCommandJob: commandRunner(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        try {
          await cron.start();
          const webhookJob = await cron.add({
            name: "webhook preview",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "command", argv: [process.execPath, "-e", "process.exit(0)"] },
            delivery: { mode: "webhook", to: "https://hooks.example.test/cron" },
          });
          const noDeliveryJob = await cron.add({
            name: "no delivery preview",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "command", argv: [process.execPath, "-e", "process.exit(0)"] },
            delivery: { mode: "none" },
          });

          const jobs = await cron.list({ includeDisabled: true });
          const previews = await resolveCronDeliveryPreviews({ cfg: {} as never, jobs });
          expect(previews).toMatchObject({
            [webhookJob.id]: {
              label: "webhook:https://hooks.example.test/cron",
              detail: "webhook",
            },
            [noDeliveryJob.id]: {
              label: "not requested",
              detail: "not requested",
            },
          });
        } finally {
          cron.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  });
});
