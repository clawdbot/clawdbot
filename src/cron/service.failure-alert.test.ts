// Cron failure alert tests cover notification behavior for failed scheduled jobs.
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];
type RunIsolatedAgentJob = NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
type IsolatedAgentRunResult = Awaited<ReturnType<RunIsolatedAgentJob>>;
type FailureAlertConfig = NonNullable<CronServiceParams["cronConfig"]>["failureAlert"];

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-failure-alert-",
  baseTimeIso: "2026-01-01T00:00:00.000Z",
});

function createTelegramDelivery(): NonNullable<CronJobCreate["delivery"]> {
  return { mode: "announce", channel: "telegram", to: "19098680" };
}

function createFailureAlertJob(
  name: string,
  overrides: Partial<CronJobCreate> = {},
): CronJobCreate {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run report" },
    ...overrides,
  };
}

async function withFailureAlertCron(
  params: {
    failureAlert: FailureAlertConfig;
    runResult?: IsolatedAgentRunResult;
  },
  run: (context: {
    cron: CronService;
    sendCronFailureAlert: ReturnType<typeof vi.fn>;
    addJob: (name: string, overrides?: Partial<CronJobCreate>) => ReturnType<CronService["add"]>;
  }) => Promise<void>,
): Promise<void> {
  const store = await makeStorePath();
  const sendCronFailureAlert = vi.fn(async () => undefined);
  const runResult = params.runResult ?? {
    status: "error",
    error: "temporary upstream error",
  };
  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    cronConfig: { failureAlert: params.failureAlert },
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => runResult),
    sendCronFailureAlert,
  });

  await cron.start();
  try {
    await run({
      cron,
      sendCronFailureAlert,
      addJob: async (name, overrides) => await cron.add(createFailureAlertJob(name, overrides)),
    });
  } finally {
    cron.stop();
  }
}

function alertCallArg(
  sendCronFailureAlert: ReturnType<typeof vi.fn>,
  callIndex = sendCronFailureAlert.mock.calls.length - 1,
): Record<string, unknown> {
  const value = sendCronFailureAlert.mock.calls[callIndex]?.[0];
  if (!value || typeof value !== "object") {
    throw new Error(`expected failure alert call ${callIndex}`);
  }
  const alert = value as Record<string, unknown>;
  const payload = alert.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...alert, ...(payload as Record<string, unknown>) }
    : alert;
}

function expectAlertFields(
  sendCronFailureAlert: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
  callIndex?: number,
): Record<string, unknown> {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  for (const [key, value] of Object.entries(expected)) {
    expect(alert[key]).toEqual(value);
  }
  return alert;
}

function expectAlertTextContaining(
  sendCronFailureAlert: ReturnType<typeof vi.fn>,
  text: string,
  callIndex?: number,
): void {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  expect(typeof alert.text).toBe("string");
  if (typeof alert.text !== "string") {
    throw new Error("expected failure alert text");
  }
  expect(alert.text).toContain(text);
}

describe("CronService failure alerts", () => {
  it("alerts after configured consecutive failures and honors cooldown", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 2, cooldownMs: 60_000 },
        runResult: { status: "error", error: "wrong model id" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("daily report", {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const firstAlert = expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "19098680",
        });
        expect((firstAlert.job as { id?: string } | undefined)?.id).toBe(job.id);
        expectAlertTextContaining(sendCronFailureAlert, 'Automation "daily report" failed 2 times');

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(60_000);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expectAlertTextContaining(sendCronFailureAlert, 'Automation "daily report" failed 4 times');
      },
    );
  });

  it("supports per-job failure alert override when global alerts are disabled", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: false },
        runResult: { status: "error", error: "timeout" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("job with override", {
          failureAlert: {
            after: 1,
            channel: "telegram",
            to: "12345",
            cooldownMs: 1,
          },
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "12345",
        });
      },
    );
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "error", error: "auth error" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("disabled alert job", { failureAlert: false });

        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();
      },
    );
  });

  it("preserves includeSkipped through failure alert updates", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("updated skipped alert job", {
          failureAlert: {
            after: 1,
            channel: "telegram",
            to: "12345",
          },
        });

        const updated = await cron.update(job.id, {
          failureAlert: {
            includeSkipped: true,
          },
        });
        const updatedFailureAlert = updated?.failureAlert;
        if (!updatedFailureAlert) {
          throw new Error("expected updated failure alert config");
        }
        expect(updatedFailureAlert.after).toBe(1);
        expect(updatedFailureAlert.channel).toBe("telegram");
        expect(updatedFailureAlert.to).toBe("12345");
        expect(updatedFailureAlert.includeSkipped).toBe(true);

        await cron.run(job.id, "force");
        expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "12345",
        });
        expectAlertTextContaining(
          sendCronFailureAlert,
          'Automation "updated skipped alert job" skipped 1 times',
        );
      },
    );
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          accountId: "global-account",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const normalJob = await addJob("normal alert job", {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        });
        const bestEffortJob = await addJob("best effort alert job", {
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "19098680",
            bestEffort: true,
          },
        });

        await cron.run(normalJob.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expectAlertFields(sendCronFailureAlert, {
          mode: "webhook",
          accountId: "global-account",
          to: undefined,
        });

        await cron.run(bestEffortJob.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
      },
    );
  });

  it.each([
    {
      name: "uses a globally configured failure webhook destination",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/cron-failures",
      },
      jobAlert: undefined,
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/cron-failures",
      },
    },
    {
      name: "uses a globally configured failure announcement channel and target",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: undefined,
      expected: {
        mode: "announce",
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
    },
    {
      name: "preserves a global route when a job explicitly repeats its alert mode",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
    },
    {
      name: "preserves an explicit job failure webhook over the global destination",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "webhook" as const,
        to: "https://alerts.example.test/job-failures",
      },
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/job-failures",
      },
    },
    {
      name: "never reuses a global webhook URL as an overridden job chat target",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
    {
      name: "never reuses a global chat target after a job changes the failure channel",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
        channel: "telegram",
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
        accountId: undefined,
      },
    },
    {
      name: "never reuses a global chat target or account for the last failure channel",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
        channel: "last",
      },
      expected: {
        mode: "announce",
        channel: "last",
        to: undefined,
        accountId: undefined,
      },
    },
    {
      name: "never reuses a global webhook channel after a job switches to chat",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        channel: "slack",
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
    {
      name: "never reuses a job chat target for a global channel-only alert",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
      },
      jobAlert: undefined,
      expected: {
        mode: "announce",
        channel: "slack",
        to: undefined,
      },
    },
    {
      name: "preserves a global webhook URL when an unused job channel is set",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        channel: "telegram",
      },
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/global-failures",
      },
    },
  ])("$name", async ({ globalAlert, jobAlert, expected }) => {
    await withFailureAlertCron({ failureAlert: globalAlert }, async (context) => {
      const { cron, sendCronFailureAlert, addJob } = context;
      const job = await addJob("globally routed failure alert", {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        },
        ...(jobAlert ? { failureAlert: jobAlert } : {}),
      });

      await cron.run(job.id, "force");

      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expectAlertFields(sendCronFailureAlert, expected);
      expectAlertTextContaining(
        sendCronFailureAlert,
        'Automation "globally routed failure alert" failed 1 times',
      );
    });
  });

  it.each([
    {
      name: "channel-shaped failure destination",
      failureDestination: { channel: "slack", to: "#alerts" },
    },
    {
      name: "webhook failure destination",
      failureDestination: {
        mode: "webhook" as const,
        to: "https://alerts.example.test/job-failures",
      },
    },
    {
      name: "clear-only failure destination opt-out",
      failureDestination: {
        channel: undefined,
        to: undefined,
        accountId: undefined,
        mode: undefined,
      },
    },
  ])("does not duplicate an explicitly owned $name", async ({ failureDestination }) => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/global-failures",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("explicitly routed failure destination", {
          delivery: { mode: "none", failureDestination },
        });

        expect(job.delivery?.failureDestination).toBeDefined();
        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).not.toHaveBeenCalled();
      },
    );
  });

  it("preserves explicit job alerts alongside an owned failure destination", async () => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/global-failures",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("explicit job alert with a failure destination", {
          delivery: {
            mode: "none",
            failureDestination: { channel: "slack", to: "#alerts" },
          },
          failureAlert: {
            after: 1,
            mode: "announce",
            channel: "telegram",
            to: "telegram:19098680",
          },
        });

        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expectAlertFields(sendCronFailureAlert, {
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        });
        expectAlertTextContaining(
          sendCronFailureAlert,
          'Automation "explicit job alert with a failure destination" failed 1 times',
        );
      },
    );
  });

  it("preserves global skipped alerts alongside an owned failure destination", async () => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          includeSkipped: true,
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        },
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("skipped job with a failure destination", {
          delivery: {
            mode: "none",
            failureDestination: { channel: "slack", to: "#alerts" },
          },
        });

        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expectAlertFields(sendCronFailureAlert, {
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        });
        expectAlertTextContaining(
          sendCronFailureAlert,
          'Automation "skipped job with a failure destination" skipped 1 times',
        );
      },
    );
  });

  it("alerts for repeated skipped runs only when opted in", async () => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
          includeSkipped: true,
        },
        runResult: { status: "skipped", error: "disabled" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("gateway restart", {
          payload: { kind: "agentTurn", message: "restart gateway if needed" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "19098680",
        });
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(typeof alertText).toBe("string");
        if (typeof alertText !== "string") {
          throw new Error("expected failure alert text");
        }
        expect(alertText).toBe(
          'Automation "gateway restart" skipped 2 times\nCheck automation history for details.',
        );

        const skippedJob = cron.getJob(job.id);
        expect(skippedJob?.state.consecutiveSkipped).toBe(2);
        expect(skippedJob?.state.consecutiveErrors).toBe(0);
      },
    );
  });

  it("keeps classified raw errors out of chat failure alerts", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "error", error: "cron: job execution timed out" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("timeout cause alert", {
          payload: { kind: "agentTurn", message: "ping" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(alertText).toBe('Automation "timeout cause alert" failed 1 times\nCause: timeout');
      },
    );
  });

  it("adds Codex login recovery to OpenAI OAuth refresh failures", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: {
          status: "error",
          provider: "openai",
          errorClassification: { kind: "reason", reason: "auth_permanent" },
          error:
            'FailoverError: OAuth token refresh failed for openai: OpenAI Codex token refresh failed (401): {"error":{"message":"Your session has ended. Please log in again.","type":"invalid_request_error"}}',
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("Sunday Magic Drop (Tax Payers)", {
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");

        const alert = alertCallArg(sendCronFailureAlert);
        expect(alert.text).toContain("Cause: auth_permanent");
        expect(alert.presentation).toEqual({
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Log in to Codex",
                  action: { type: "command", command: "/login codex" },
                },
              ],
            },
          ],
        });
      },
    );
  });

  it("does not offer Codex login for non-OAuth authentication failures", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: {
          status: "error",
          provider: "openai",
          error: "401 invalid API key",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("API key job", { delivery: createTelegramDelivery() });

        await cron.run(job.id, "force");

        expect(alertCallArg(sendCronFailureAlert).presentation).toBeUndefined();
      },
    );
  });

  it("does not reclassify permanent local script errors in failure alerts", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: {
          status: "error",
          error: "cron script failed after a tool side effect: request timed out",
          errorClassification: { kind: "permanent" },
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("permanent script alert", {
          payload: { kind: "agentTurn", message: "ping" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expect(alertCallArg(sendCronFailureAlert).text).toBe(
          'Automation "permanent script alert" failed 1 times\n' +
            "Check automation history for details.",
        );
      },
    );
  });

  it("keeps skipped alert text unchanged when the skip reason looks classifiable", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1, includeSkipped: true },
        runResult: { status: "skipped", error: "cron: job execution timed out" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("skipped timeout", {
          payload: { kind: "agentTurn", message: "ping" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(alertText).toBe(
          'Automation "skipped timeout" skipped 1 times\n' +
            "Check automation history for details.",
        );
      },
    );
  });

  it("tracks skipped runs without alerting or affecting error backoff when includeSkipped is off", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("busy heartbeat", { delivery: createTelegramDelivery() });

        await cron.run(job.id, "force");
        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).not.toHaveBeenCalled();
        const skippedJob = cron.getJob(job.id);
        expect(skippedJob?.state.consecutiveSkipped).toBe(2);
        expect(skippedJob?.state.consecutiveErrors).toBe(0);
      },
    );
  });

  it("truncates webhook failure alert error text on UTF-16 code-point boundary", async () => {
    // 209 code units: emoji (surrogate pair) at positions 199-200 straddles the 200-unit boundary
    const longError = `${"x".repeat(199)}🎉trailing`;
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/failures",
        },
        runResult: { status: "error", error: longError },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("utf16 boundary job", {
          payload: { kind: "agentTurn", message: "ping" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(typeof alertText).toBe("string");
        if (typeof alertText !== "string") {
          throw new Error("expected failure alert text");
        }

        // Verify no dangling surrogates in the truncated error text.
        // Must check every character including the last: a dangling high surrogate
        // at the final position would be missed by stopping at length-1.
        for (let i = 0; i < alertText.length; i++) {
          const cu = alertText.charCodeAt(i);
          if (cu >= 0xd800 && cu <= 0xdbff) {
            expect(
              alertText.charCodeAt(i + 1) >= 0xdc00 && alertText.charCodeAt(i + 1) <= 0xdfff,
            ).toBe(true);
          }
          if (cu >= 0xdc00 && cu <= 0xdfff) {
            expect(
              i > 0 &&
                alertText.charCodeAt(i - 1) >= 0xd800 &&
                alertText.charCodeAt(i - 1) <= 0xdbff,
            ).toBe(true);
          }
        }

        // Verify the emoji was excluded (truncated at the safe boundary before it)
        expect(alertText).not.toContain("🎉");
      },
    );
  });
});
