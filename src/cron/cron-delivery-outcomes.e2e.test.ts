import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
  sendGatewayCronWebhook,
} from "../gateway/server-cron-notifications.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
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
  requests: WebhookRequest[];
  request: Promise<WebhookRequest>;
  url: string;
}> {
  const requests: WebhookRequest[] = [];
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
      const received = {
        body: JSON.parse(body) as Record<string, unknown>,
        path: incoming.url ?? "",
      };
      requests.push(received);
      resolveRequest(received);
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
    requests,
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

describe("cron delivery outcomes", { concurrent: false }, () => {
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

            for (const command of [
              "process.exit(0)",
              "process.stdout.write('  \\n')",
              "process.exit(1)",
            ]) {
              await cron.update(job.id, {
                payload: { kind: "command", argv: [process.execPath, "-e", command] },
              });
              await cron.run(job.id, "force");
              const failed = command === "process.exit(1)";
              expect(receiver.requests).toHaveLength(failed ? 2 : 1);
              expect(await persistedJob(storePath, job.id)).toMatchObject({
                state: {
                  lastRunStatus: failed ? "error" : "ok",
                  lastDeliveryStatus: failed ? "delivered" : "not-delivered",
                },
              });
              if (!failed) {
                expect(
                  (await persistedJob(storePath, job.id))?.state.deliverySuppressionReason,
                ).toBe("empty");
              }
            }
            expect(receiver.requests[1]?.body).toMatchObject({ status: "error" });
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

  it("applies threshold and cooldown once before transporting execution failure alerts", async () => {
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
            runIsolatedAgentJob: vi.fn(async () => ({
              status: "error" as const,
              error: "monitor failed",
            })),
            sendCronFailureAlert: async (params) =>
              await sendGatewayCronFailureAlert({
                ...params,
                deps: {} as never,
                logger: createNoopLogger(),
                resolveCronAgent: () => ({ agentId: "main", cfg: {} as never }),
                ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
              }),
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
              name: "60-second monitor",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "check health" },
              delivery: {
                mode: "none",
                failureDestination: { mode: "webhook", to: receiver.url },
              },
            });

            for (let index = 0; index < 21; index += 1) {
              await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
            }
            const disabled = await cron.add({
              name: "disabled failure alert",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "check health quietly" },
              delivery: {
                mode: "none",
                failureDestination: { mode: "webhook", to: receiver.url },
              },
              failureAlert: false,
            });
            for (let index = 0; index < 2; index += 1) {
              await expect(cron.run(disabled.id, "force")).resolves.toEqual({
                ok: true,
                ran: true,
              });
            }

            await receiver.request;
            await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
            expect(receiver.requests).toHaveLength(1);
            expect(receiver.requests[0]).toMatchObject({
              path: "/cron",
              body: {
                jobId: job.id,
                jobName: "60-second monitor",
                message:
                  'Automation "60-second monitor" failed 2 times\nLast error: monitor failed',
              },
            });
            expect(await persistedJob(storePath, job.id)).toMatchObject({
              state: {
                lastRunStatus: "error",
                lastError: "monitor failed",
                consecutiveErrors: 21,
                lastFailureAlertAtMs: expect.any(Number),
                lastFailureNotificationDeliveryStatus: "not-requested",
              },
            });
            const history = readCronTaskRunHistoryPage({
              storeKey: cronStoreKey(storePath),
              jobId: job.id,
              limit: 25,
            });
            expect(history.total).toBe(21);
            expect(history.entries).toHaveLength(21);
            expect(history.entries).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ status: "error", error: "monitor failed" }),
              ]),
            );
            expect(
              history.entries.filter(
                (entry) => entry.failureNotificationDelivery?.status === "unknown",
              ),
            ).toHaveLength(1);
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

  it("routes required completion-delivery failure immediately without changing execution streak", async () => {
    const receiver = await createWebhookReceiver();
    try {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-completion-failure-" },
        async (state) => {
          resetTaskRegistryForTests({ persist: false });
          const storePath = state.path("cron", "jobs.json");
          let now = Date.now();
          const cron = new CronService({
            storePath,
            cronEnabled: true,
            nowMs: () => now,
            log: createNoopLogger(),
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runIsolatedAgentJob: vi.fn(async () => ({
              status: "ok" as const,
              delivered: false,
              deliveryAttempted: true,
              deliveryError: "primary route rejected",
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
              name: "required completion delivery",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "build report" },
              delivery: {
                mode: "announce",
                bestEffort: false,
                channel: "telegram",
                to: "123",
                failureDestination: { mode: "webhook", to: receiver.url },
              },
            });

            await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
            expect(await receiver.request).toMatchObject({
              path: "/cron",
              body: {
                jobId: job.id,
                message:
                  'Automation "required completion delivery" delivery failed\nLast error: primary route rejected',
              },
            });
            await vi.waitFor(async () => {
              expect(await persistedJob(storePath, job.id)).toMatchObject({
                state: {
                  lastRunStatus: "ok",
                  lastDeliveryStatus: "not-delivered",
                  lastDeliveryError: "primary route rejected",
                  consecutiveErrors: 0,
                  lastFailureNotificationDelivered: true,
                  lastFailureNotificationDeliveryStatus: "delivered",
                  lastFailureAlertAtMs: now,
                },
              });
            });

            now += 60_000;
            await cron.run(job.id, "force");
            await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
            expect(receiver.requests).toHaveLength(1);
            const history = readCronTaskRunHistoryPage({
              storeKey: cronStoreKey(storePath),
              jobId: job.id,
              limit: 10,
            });
            expect(history.entries).toHaveLength(2);
            expect(
              history.entries.every(
                (entry) =>
                  entry.completionStatus === "failed" && entry.deliveryStatus === "not-delivered",
              ),
            ).toBe(true);
            expect(
              history.entries.filter(
                (entry) => entry.failureNotificationDelivery?.status === "unknown",
              ),
            ).toHaveLength(1);

            now += 3_540_000;
            await cron.run(job.id, "force");
            await vi.waitFor(() => expect(receiver.requests).toHaveLength(2));

            const disabled = await cron.add({
              name: "disabled completion failure alert",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "build report quietly" },
              delivery: {
                mode: "announce",
                bestEffort: false,
                channel: "telegram",
                to: "123",
                failureDestination: { mode: "webhook", to: receiver.url },
              },
              failureAlert: false,
            });
            await cron.run(disabled.id, "force");
            await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
            expect(receiver.requests).toHaveLength(2);
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

  it("falls back to the exact job owner when Gateway alert transport rejects", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-alert-fallback-" },
      async (state) => {
        const enqueueSystemEvent = vi.fn();
        const requestHeartbeat = vi.fn();
        const storePath = state.path("cron", "jobs.json");
        const cron = new CronService({
          storePath,
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent,
          requestHeartbeat,
          runIsolatedAgentJob: vi.fn(async () => ({
            status: "error" as const,
            error: "provider unavailable",
          })),
          sendCronFailureAlert: async (params) =>
            await sendGatewayCronFailureAlert({
              ...params,
              deps: {} as never,
              logger: createNoopLogger(),
              resolveCronAgent: () => ({ agentId: "work", cfg: {} as never }),
            }),
        });
        try {
          await cron.start();
          const sessionKey = "agent:work:cron:failure-fallback";
          const job = await cron.add({
            name: "fallback owner",
            enabled: true,
            agentId: "work",
            sessionKey,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "check provider" },
            delivery: { mode: "none" },
            failureAlert: {
              after: 1,
              mode: "webhook",
              to: "http://127.0.0.1:9/failure",
            },
          });

          await cron.run(job.id, "force");

          await vi.waitFor(() =>
            expect(enqueueSystemEvent).toHaveBeenCalledWith(
              expect.stringContaining('Automation "fallback owner" failed 1 times'),
              { agentId: "work", sessionKey, contextKey: `cron:${job.id}:failure-alert` },
            ),
          );
          expect(requestHeartbeat).toHaveBeenCalledWith({
            source: "notifications-event",
            intent: "immediate",
            reason: "wake",
            agentId: "work",
            sessionKey,
          });
          await vi.waitFor(async () => {
            expect(await persistedJob(storePath, job.id)).toMatchObject({
              state: {
                lastFailureNotificationDelivered: false,
                lastFailureNotificationDeliveryStatus: "not-delivered",
                lastFailureNotificationDeliveryError: expect.stringContaining(
                  "Blocked hostname or private/internal/special-use IP address",
                ),
              },
            });
          });
        } finally {
          cron.stop();
        }
      },
    );
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
            await vi.waitFor(async () => {
              expect(await persistedJob(storePath, job.id)).toMatchObject({
                state: {
                  lastRunStatus: "skipped",
                  consecutiveSkipped: 1,
                  lastFailureAlertAtMs: expect.any(Number),
                  lastFailureNotificationDelivered: true,
                  lastFailureNotificationDeliveryStatus: "delivered",
                },
              });
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
