// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type { CronJob } from "../cron/types.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (_request: unknown) => ({
    response: new Response(null, { status: 204 }),
    finalUrl: "https://example.invalid/cron",
    release: vi.fn(async () => {}),
  })),
  sendFailureNotificationAnnounce: vi.fn(),
  sendCronAnnouncePayloadStrict: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendFailureNotificationAnnounce: mocks.sendFailureNotificationAnnounce,
    sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
  };
});

import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";

function waitForFast(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, { interval: 1 });
}

const requireRecord = createRequireRecord("object", "expected-label");

function webhookRequestBody() {
  const call = (mocks.fetchWithSsrFGuard.mock.calls as unknown[][])[0];
  if (!call) {
    throw new Error("expected webhook request call");
  }
  const request = requireRecord(call[0], "webhook request");
  const init = requireRecord(request.init, "webhook request init");
  if (typeof init.body !== "string") {
    throw new Error("expected webhook request body");
  }
  return JSON.parse(init.body);
}

function createVoidDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createWebhookJob(delivery: NonNullable<CronJob["delivery"]>): CronJob {
  return {
    id: "cron-notification-admission",
    name: "notification admission",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery,
    state: {},
  };
}

function createCompletionWebhookJob(url = "https://example.invalid/cron"): CronJob {
  return createWebhookJob({
    mode: "announce",
    completionDestination: { mode: "webhook", to: url },
  });
}

const webhookSsrfPolicy = { allowedHostnames: ["127.0.0.1"] };
const webhookSsrfPolicyRequest = expect.objectContaining({ policy: webhookSsrfPolicy });

function expectWebhookSsrfPolicy() {
  expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(webhookSsrfPolicyRequest);
}

describe("dispatchGatewayCronFinishedNotifications", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.fetchWithSsrFGuard.mockImplementation(async () => ({
      response: new Response(null, { status: 204 }),
      finalUrl: "https://example.invalid/cron",
      release: vi.fn(async () => {}),
    }));
    mocks.sendFailureNotificationAnnounce.mockResolvedValue(undefined);
    mocks.sendCronAnnouncePayloadStrict.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    setActiveDegradedSecretOwners([]);
  });

  it("independently admits detached completion webhook delivery", async () => {
    const deferred = createVoidDeferred();
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async () => {
      await deferred.promise;
      return {
        response: new Response(null, { status: 204 }),
        finalUrl: "https://example.invalid/cron",
        release: vi.fn(async () => {}),
      };
    });
    const job = createCompletionWebhookJob();
    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    expect(parentAdmission).not.toBeNull();
    if (!parentAdmission) {
      throw new Error("expected parent Gateway work admission");
    }

    try {
      await parentAdmission.run(async () => {
        dispatchGatewayCronFinishedNotifications({
          evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
          job,
          deps: {} as CliDeps,
          logger: { warn: vi.fn() },
          resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
        });

        await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
        expect(getActiveGatewayRootWorkCount()).toBe(2);
      });
    } finally {
      parentAdmission.release();
    }

    expect(getActiveGatewayRootWorkCount()).toBe(1);
    deferred.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("keeps webhook delivery cold when its token owner is unavailable", async () => {
    const logger = { warn: vi.fn() };
    const job = createCompletionWebhookJob();
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "cron-webhook",
        state: "unavailable",
        paths: ["cron.webhookToken"],
        refKeys: ["env:default:MISSING_WEBHOOK_TOKEN"],
        reason: "secret provider failed",
      },
    ]);

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          err: expect.stringContaining("Secret owner capability:cron-webhook"),
        }),
        "cron: webhook delivery failed",
      ),
    );
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it.each([400, 401, 429, 500, 503])(
    "reports and releases an unsuccessful completion webhook (HTTP %i)",
    async (status) => {
      const release = vi.fn(async () => {});
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: new Response(null, { status }),
        finalUrl: "https://example.invalid/cron",
        release,
      });
      const logger = { warn: vi.fn() };
      const job = createCompletionWebhookJob(
        "https://example.invalid/cron?token=must-not-be-logged",
      );

      dispatchGatewayCronFinishedNotifications({
        evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
        job,
        deps: {} as CliDeps,
        logger,
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      });

      await waitForFast(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: job.id,
            source: "completionDestination",
            err: expect.stringContaining(String(status)),
            webhookUrl: "https://example.invalid/cron",
          }),
          "cron: webhook delivery failed",
        ),
      );
      expect(release).toHaveBeenCalledOnce();
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("must-not-be-logged");
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    },
  );

  it("cancels an unread webhook response before releasing its guard", async () => {
    const cleanupOrder: string[] = [];
    const response = new Response(
      new ReadableStream({
        cancel() {
          cleanupOrder.push("cancel");
        },
      }),
      { status: 200 },
    );
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response,
      finalUrl: "https://example.invalid/cron",
      release: vi.fn(async () => {
        cleanupOrder.push("release");
      }),
    });

    await sendGatewayCronFailureAlert({
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      job: createWebhookJob({
        mode: "webhook",
        to: "https://example.invalid/cron",
      }),
      payload: { text: "cron failed" },
      channel: "last",
      mode: "webhook",
      to: "https://example.invalid/cron",
    });

    expect(cleanupOrder).toEqual(["cancel", "release"]);
  });

  it("releases Gateway admission when webhook response cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => {});
      const response = new Response(
        new ReadableStream({ cancel: () => new Promise<void>(() => {}) }),
      );
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response,
        finalUrl: "https://example.invalid/cron",
        release,
      });

      const delivery = sendGatewayCronFailureAlert({
        deps: {} as CliDeps,
        logger: { warn: vi.fn() },
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
        job: createWebhookJob({
          mode: "webhook",
          to: "https://example.invalid/cron",
        }),
        payload: { text: "cron failed" },
        channel: "last",
        mode: "webhook",
        to: "https://example.invalid/cron",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(release).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the primary topic on immediate failure alerts", async () => {
    const job = createWebhookJob({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      accountId: "bot-a",
      threadId: 42,
    });

    await sendGatewayCronFailureAlert({
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      job,
      payload: { text: "cron failed" },
      channel: "telegram",
      to: "-1001234567890",
      accountId: "bot-a",
      threadId: 42,
      mode: "announce",
    });

    expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          channel: "telegram",
          to: "-1001234567890",
          accountId: "bot-a",
          threadId: 42,
        }),
      }),
    );
  });

  it("keeps immediate failure webhook messages stable and adds structured runAtMs", async () => {
    const runAtMs = Date.parse("2026-01-15T15:30:00.000Z");
    const job = createCompletionWebhookJob();

    await sendGatewayCronFailureAlert({
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      }),
      job,
      payload: { text: "cron failed" },
      runAtMs,
      channel: "last",
      mode: "webhook",
      to: "https://example.invalid/cron",
      ssrfPolicy: webhookSsrfPolicy,
    });

    expectWebhookSsrfPolicy();
    expect(webhookRequestBody()).toEqual({
      jobId: job.id,
      jobName: job.name,
      message: "cron failed",
      runAtMs,
    });
  });

  it("delivers a failed cron webhook even when the run produced no summary", async () => {
    const logger = { warn: vi.fn() };
    const job = createCompletionWebhookJob();

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "provider unavailable",
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      ssrfPolicy: webhookSsrfPolicy,
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    expectWebhookSsrfPolicy();
    expect(webhookRequestBody()).toMatchObject({
      jobId: job.id,
      action: "finished",
      status: "error",
      error: "provider unavailable",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("applies the webhook timeout to guarded network preflight", async () => {
    const job = createCompletionWebhookJob();

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() =>
      expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 10_000 }),
      ),
    );
  });

  it("delivers a failed completion-destination webhook without a summary", async () => {
    const logger = { warn: vi.fn() };
    const job = createWebhookJob({
      mode: "announce",
      completionDestination: {
        mode: "webhook",
        to: "https://example.invalid/completion",
      },
    });

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "provider unavailable",
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    expect(webhookRequestBody()).toMatchObject({
      jobId: job.id,
      action: "finished",
      status: "error",
      error: "provider unavailable",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("independently admits immediate failure alerts", async () => {
    const deferred = createVoidDeferred();
    mocks.sendCronAnnouncePayloadStrict.mockImplementationOnce(async () => {
      await deferred.promise;
    });
    const job = createWebhookJob({ mode: "announce", channel: "discord", to: "channel:ops" });

    const delivery = sendGatewayCronFailureAlert({
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      job,
      payload: { text: "cron failed" },
      channel: "discord",
      to: "channel:ops",
      mode: "announce",
    });

    await waitForFast(() => expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledOnce());
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    deferred.resolve();
    await delivery;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each([
    { description: "honors cancellation", honorsCancellation: true },
    { description: "ignores cancellation", honorsCancellation: false },
  ])(
    "releases immediate failure alert admission when a stalled sender $description",
    async ({ honorsCancellation }) => {
      vi.useFakeTimers();
      try {
        let deliverySignal: AbortSignal | undefined;
        mocks.sendCronAnnouncePayloadStrict.mockImplementationOnce(
          ({ abortSignal }: { abortSignal: AbortSignal }) =>
            new Promise<void>((_resolve, reject) => {
              deliverySignal = abortSignal;
              if (honorsCancellation) {
                abortSignal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      abortSignal.reason instanceof Error
                        ? abortSignal.reason
                        : new Error("cron: failure alert announcement timed out"),
                    ),
                  { once: true },
                );
              }
            }),
        );
        const job = createWebhookJob({ mode: "announce", channel: "discord", to: "channel:ops" });

        const delivery = sendGatewayCronFailureAlert({
          deps: {} as CliDeps,
          logger: { warn: vi.fn() },
          resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
          job,
          payload: { text: "cron failed" },
          channel: "discord",
          to: "channel:ops",
          mode: "announce",
        });
        const deliveryOutcome = delivery.then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(deliverySignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(9_999);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(deliverySignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(deliverySignal?.aborted).toBe(true);
        await expect(deliveryOutcome).resolves.toEqual(
          expect.objectContaining({ message: "cron: failure alert announcement timed out" }),
        );
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("defers detached completion delivery while suspension is prepared", async () => {
    const job = createCompletionWebhookJob();
    const suspensionAdmission = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspensionAdmission?.commit()).toBe(true);

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await Promise.resolve();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    expect(suspensionAdmission?.release()).toBe(true);
    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
  });

  it("independently admits failure destination webhook delivery", async () => {
    const deferred = createVoidDeferred();
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async () => {
      await deferred.promise;
      return {
        response: new Response(null, { status: 204 }),
        finalUrl: "https://example.invalid/failure",
        release: vi.fn(async () => {}),
      };
    });
    const job = createWebhookJob({
      mode: "announce",
      channel: "last",
      failureDestination: {
        mode: "webhook",
        to: "https://example.invalid/failure",
      },
    });

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "error", error: "boom" },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      ssrfPolicy: webhookSsrfPolicy,
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
    expectWebhookSsrfPolicy();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    deferred.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("independently admits failure destination announce delivery", async () => {
    const deferred = createVoidDeferred();
    mocks.sendFailureNotificationAnnounce.mockImplementationOnce(() => deferred.promise);
    const job = createWebhookJob({
      mode: "announce",
      channel: "last",
      failureDestination: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
      },
    });

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "error", error: "boom" },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() => expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledTimes(1));
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    deferred.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("uses the persisted run failure reason for chat without changing webhook text", async () => {
    const runAtMs = Date.parse("2026-01-15T15:30:00.000Z");
    const announceJob = createWebhookJob({
      mode: "announce",
      failureDestination: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
      },
    });
    announceJob.state.lastErrorReason = "auth";
    announceJob.state.consecutiveErrors = 9;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: announceJob.id,
        action: "finished",
        status: "error",
        error: "provider overloaded",
        runAtMs,
      },
      job: announceJob,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      }),
    });

    expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "main",
      announceJob.id,
      expect.anything(),
      {
        text:
          '⚠️ Automation "notification admission" failed\n' +
          "Cause: auth\n" +
          "Run started: 2026-01-15 10:30 EST",
      },
    );

    vi.clearAllMocks();
    announceJob.state.lastErrorReason = undefined;
    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: announceJob.id,
        action: "finished",
        status: "error",
        error: "script failed permanently after request timed out",
      },
      job: announceJob,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });
    expect(mocks.sendFailureNotificationAnnounce.mock.calls[0]?.[5]).toEqual({
      text: '⚠️ Automation "notification admission" failed\nCheck automation history for details.',
    });

    vi.clearAllMocks();
    const webhookJob = createWebhookJob({
      mode: "announce",
      failureDestination: {
        mode: "webhook",
        to: "https://example.invalid/failure",
      },
    });
    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: webhookJob.id,
        action: "finished",
        status: "error",
        error: "provider unavailable",
        runAtMs,
      },
      job: webhookJob,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      }),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    expect(webhookRequestBody()).toMatchObject({
      message: 'Automation "notification admission" failed: provider unavailable',
      runAtMs,
    });
  });

  it("redacts invalid completion webhook targets in warnings", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-redact",
      name: "redact",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "ftp://user:secret@example.invalid/hook?token=secret",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: "cron-redact",
        deliveryTo: "ftp://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
  });

  it("rejects credential-bearing completion webhook targets before fetch", () => {
    const logger = {
      warn: vi.fn(),
    };
    const credentialUrl = new URL("https://example.invalid/hook?token=placeholder");
    credentialUrl.username = "user";
    credentialUrl.password = "password";
    const job = createWebhookJob({
      mode: "announce",
      completionDestination: {
        mode: "webhook",
        to: credentialUrl.href,
      },
    });

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: job.id,
        deliveryTo: "https://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("keeps configured failure destinations from inheriting the primary delivery thread", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-threaded-failure-dest",
      name: "threaded failure dest",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        threadId: 42,
        failureDestination: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "boom",
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledTimes(1);
    expect(mocks.sendFailureNotificationAnnounce.mock.calls[0]?.[4]).toEqual({
      channel: "telegram",
      to: "-1001234567890",
      accountId: undefined,
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      inheritSessionThread: false,
    });
  });

  it("preserves the primary topic when a failed run falls back to its delivery route", () => {
    const job = createWebhookJob({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      accountId: "bot-a",
      threadId: 42,
    });

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "error", error: "boom" },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "main",
      job.id,
      expect.objectContaining({
        channel: "telegram",
        to: "-1001234567890",
        accountId: "bot-a",
        threadId: 42,
      }),
      expect.objectContaining({ text: expect.any(String) }),
    );
  });

  it("announces channel-shaped failure destinations without mode under a global webhook default (#102235)", () => {
    const logger = { warn: vi.fn() };
    const job = makeCronJob({
      id: "cron-channel-fd-no-mode",
      name: "channel fd no mode",
      delivery: {
        mode: "none",
        failureDestination: { channel: "slack", to: "#alerts" },
      },
    });

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "boom",
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      globalFailureDestination: {
        mode: "webhook",
        to: "https://hook.example/cron",
      },
    });

    expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "main",
      job.id,
      {
        channel: "slack",
        to: "#alerts",
        accountId: undefined,
        sessionKey: undefined,
        inheritSessionThread: false,
      },
      {
        text: '⚠️ Automation "channel fd no mode" failed\nCheck automation history for details.',
      },
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }),
      "cron: failure destination webhook URL is invalid, skipping",
    );
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("redacts command action-required summaries before webhook completion delivery", async () => {
    const logger = { warn: vi.fn() };
    const sensitiveSummary =
      "action-required output preserved:\nVisit www.example.com/device and enter code 123456\nLog in with token=opaque-secret-value";
    const job = {
      id: "cron-command-webhook-redact",
      name: "command webhook redact",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "command", argv: ["echo", "ok"] },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "https://example.invalid/cron",
        },
      },
      state: {
        lastDiagnosticSummary: sensitiveSummary,
        lastDiagnostics: {
          summary: sensitiveSummary,
          entries: [
            {
              ts: 1,
              source: "exec",
              severity: "warn",
              message: sensitiveSummary,
            },
          ],
        },
      },
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "ok",
        summary: sensitiveSummary,
        diagnostics: {
          summary: sensitiveSummary,
          entries: [
            {
              ts: 1,
              source: "exec",
              severity: "warn",
              message:
                "argv: node -e Visit www.example.com/device and enter code 123456; Log in with token=opaque-secret-value",
            },
          ],
        },
        job,
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
    const body = webhookRequestBody();
    expect(body.summary).toContain("[redacted-url]");
    expect(body.summary).toContain("[redacted-code]");
    expect(body.summary).toContain("token=***");
    expect(body.summary).not.toContain("www.example.com/device");
    expect(body.summary).not.toContain("123456");
    expect(body.summary).not.toContain("opaque-secret-value");
    expect(body.diagnostics.summary).toBe(body.summary);
    expect(body.diagnostics.entries[0].message).toContain("[redacted-url]");
    expect(body.diagnostics.entries[0].message).toContain("[redacted-code]");
    expect(body.diagnostics.entries[0].message).toContain("token=***");
    expect(body.diagnostics.entries[0].message).not.toContain("www.example.com/device");
    expect(body.diagnostics.entries[0].message).not.toContain("123456");
    expect(body.diagnostics.entries[0].message).not.toContain("opaque-secret-value");
    expect(body.job.state).not.toHaveProperty("lastDiagnosticSummary");
    expect(body.job.state).not.toHaveProperty("lastDiagnostics");
  });

  it("omits failed command summaries and diagnostics from completion webhook delivery", async () => {
    const logger = { warn: vi.fn() };
    const sensitiveSummary =
      "action-required output preserved:\nVisit www.example.com/device and enter code 123456\nLog in with token=opaque-secret-value";
    const job = {
      id: "cron-command-webhook-failed-redact",
      name: "command webhook failed redact",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "command", argv: ["node", "-e", "process.exit(7)"] },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "https://example.invalid/cron",
        },
      },
      state: {
        lastDiagnosticSummary: sensitiveSummary,
        lastDiagnostics: {
          summary: sensitiveSummary,
          entries: [
            {
              ts: 1,
              source: "exec",
              severity: "error",
              message: sensitiveSummary,
            },
          ],
        },
      },
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "command exited with code 7",
        summary: sensitiveSummary,
        diagnostics: {
          summary: sensitiveSummary,
          entries: [
            {
              ts: 1,
              source: "exec",
              severity: "error",
              message: sensitiveSummary,
            },
          ],
        },
        job,
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
    const body = webhookRequestBody();
    expect(body).toMatchObject({
      action: "finished",
      jobId: job.id,
      status: "error",
      error: "command exited with code 7",
    });
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("diagnostics");
    expect(body.job.state).not.toHaveProperty("lastDiagnosticSummary");
    expect(body.job.state).not.toHaveProperty("lastDiagnostics");
    expect(JSON.stringify(body)).not.toContain("www.example.com/device");
    expect(JSON.stringify(body)).not.toContain("123456");
    expect(JSON.stringify(body)).not.toContain("opaque-secret-value");
  });
});
