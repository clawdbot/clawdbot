// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
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
  fetchWithSsrFGuard: vi.fn(async (_request: unknown) => ({ release: vi.fn() })),
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

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

describe("dispatchGatewayCronFinishedNotifications", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.fetchWithSsrFGuard.mockImplementation(async () => ({ release: vi.fn() }));
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
      return { release: vi.fn() };
    });
    const job = createWebhookJob({
      mode: "webhook",
      to: "https://example.invalid/cron",
    });
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
    const job = createWebhookJob({
      mode: "webhook",
      to: "https://example.invalid/cron",
    });
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
      text: "cron failed",
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

  it("defers detached completion delivery while suspension is prepared", async () => {
    const job = createWebhookJob({
      mode: "webhook",
      to: "https://example.invalid/cron",
    });
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
      return { release: vi.fn() };
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
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
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
      '⚠️ Cron job "channel fd no mode" failed: boom',
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
        mode: "webhook",
        to: "https://example.invalid/cron",
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
