import { describe, expect, it } from "vitest";
import {
  applyJobPatch,
  createJob,
  recomputeNextRuns,
  recomputeNextRunsForMaintenance,
  resolveJobPayloadTextForMain,
} from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";
import type { CronJob, CronJobPatch } from "./types.js";

function expectCronStaggerMs(job: CronJob, expected: number): void {
  expect(job.schedule.kind).toBe("cron");
  if (job.schedule.kind === "cron") {
    expect(job.schedule.staggerMs).toBe(expected);
  }
}

describe("applyJobPatch", () => {
  const createIsolatedAgentTurnJob = (
    id: string,
    delivery: CronJob["delivery"],
    overrides?: Partial<CronJob>,
  ): CronJob => {
    const now = Date.now();
    return {
      id,
      name: id,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery,
      state: {},
      ...overrides,
    };
  };

  const switchToMainPatch = (): CronJobPatch => ({
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "ping" },
  });

  const createMainSystemEventJob = (id: string, delivery: CronJob["delivery"]): CronJob => {
    return createIsolatedAgentTurnJob(id, delivery, {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    });
  };

  it("clears delivery when switching to main session", () => {
    const job = createIsolatedAgentTurnJob("job-1", {
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    expect(() => applyJobPatch(job, switchToMainPatch())).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.payload.kind).toBe("systemEvent");
    expect(job.delivery).toBeUndefined();
  });

  it("keeps webhook delivery when switching to main session", () => {
    const job = createIsolatedAgentTurnJob("job-webhook", {
      mode: "webhook",
      to: "https://example.invalid/cron",
    });

    expect(() => applyJobPatch(job, switchToMainPatch())).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/cron" });
  });

  it("applies explicit delivery patches", () => {
    const job = createIsolatedAgentTurnJob("job-2", {
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    const patch: CronJobPatch = {
      delivery: {
        mode: "none",
        channel: "signal",
        to: "555",
        bestEffort: true,
      },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("do it");
    }
    expect(job.delivery).toEqual({
      mode: "none",
      channel: "signal",
      to: "555",
      bestEffort: true,
    });
  });

  it("applies explicit delivery patches for custom session targets", () => {
    const job = createIsolatedAgentTurnJob(
      "job-custom-session",
      {
        mode: "announce",
        channel: "telegram",
        to: "123",
      },
      { sessionTarget: "session:project-alpha" },
    );

    applyJobPatch(job, {
      delivery: { mode: "announce", to: "555" },
    });

    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "555",
      bestEffort: undefined,
    });
  });

  it("merges delivery.accountId from patch and preserves existing", () => {
    const job = createIsolatedAgentTurnJob("job-acct", {
      mode: "announce",
      channel: "telegram",
      to: "-100123",
    });

    applyJobPatch(job, { delivery: { mode: "announce", accountId: " coordinator " } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.to).toBe("-100123");

    // Updating other fields preserves accountId
    applyJobPatch(job, { delivery: { mode: "announce", to: "-100999" } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.to).toBe("-100999");

    // Clearing accountId with empty string
    applyJobPatch(job, { delivery: { mode: "announce", accountId: "" } });
    expect(job.delivery?.accountId).toBeUndefined();
  });

  it("persists agentTurn payload.lightContext updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-light-context", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      lightContext: true,
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        lightContext: false,
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.lightContext).toBe(false);
    }
  });

  it("persists agentTurn payload.fallbacks updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-fallbacks", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      fallbacks: ["openrouter/gpt-4.1-mini"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.fallbacks).toEqual(["anthropic/claude-haiku-3-5", "openai/gpt-5"]);
    }
  });

  it("persists agentTurn payload.toolsAllow updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-tools", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      toolsAllow: ["exec"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: ["read", "write"],
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.toolsAllow).toEqual(["read", "write"]);
    }
  });

  it("clears agentTurn payload.toolsAllow when patch requests null", () => {
    const job = createIsolatedAgentTurnJob("job-tools-clear", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      toolsAllow: ["exec", "read"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: null,
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.toolsAllow).toBeUndefined();
    }
  });

  it("applies payload.lightContext when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-light-context-switch", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        lightContext: true,
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.lightContext).toBe(true);
    }
  });

  it("carries payload.fallbacks when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-fallbacks-switch", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.fallbacks).toEqual(["anthropic/claude-haiku-3-5", "openai/gpt-5"]);
    }
  });

  it("carries payload.toolsAllow when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-tools-switch", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: ["exec", "read"],
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.toolsAllow).toEqual(["exec", "read"]);
    }
  });

  it.each([
    { name: "no delivery update", patch: { enabled: true } satisfies CronJobPatch },
    {
      name: "blank webhook target",
      patch: { delivery: { mode: "webhook", to: "" } } satisfies CronJobPatch,
    },
    {
      name: "non-http protocol",
      patch: {
        delivery: { mode: "webhook", to: "ftp://example.invalid" },
      } satisfies CronJobPatch,
    },
    {
      name: "invalid URL",
      patch: { delivery: { mode: "webhook", to: "not-a-url" } } satisfies CronJobPatch,
    },
  ] as const)("rejects invalid webhook delivery target URL: $name", ({ patch }) => {
    const expectedError = "cron webhook delivery requires delivery.to to be a valid http(s) URL";
    const job = createMainSystemEventJob("job-webhook-invalid", { mode: "webhook" });
    expect(() => applyJobPatch(job, patch)).toThrow(expectedError);
  });

  it("trims webhook delivery target URLs", () => {
    const job = createMainSystemEventJob("job-webhook-trim", {
      mode: "webhook",
      to: "https://example.invalid/original",
    });

    expect(() =>
      applyJobPatch(job, { delivery: { mode: "webhook", to: "  https://example.invalid/trim  " } }),
    ).not.toThrow();
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/trim" });
  });

  it("rejects failureDestination on main jobs without webhook delivery mode", () => {
    const job = createMainSystemEventJob("job-main-failure-dest", {
      mode: "announce",
      channel: "telegram",
      to: "123",
      failureDestination: {
        mode: "announce",
        channel: "telegram",
        to: "999",
      },
    });

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  });

  it("validates and trims webhook failureDestination target URLs", () => {
    const expectedError =
      "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL";
    const job = createIsolatedAgentTurnJob("job-failure-webhook-target", {
      mode: "announce",
      channel: "telegram",
      to: "123",
      failureDestination: {
        mode: "webhook",
        to: "not-a-url",
      },
    });

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(expectedError);

    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "123",
      failureDestination: {
        mode: "webhook",
        to: "  https://example.invalid/failure  ",
      },
    };
    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
    expect(job.delivery?.failureDestination?.to).toBe("https://example.invalid/failure");
  });

  it("preserves raw channel delivery targets for plugin-owned validation", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-invalid", {
      mode: "announce",
      channel: "telegram",
      to: "-10012345/6789",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
    expect(job.delivery?.to).toBe("-10012345/6789");
  });

  it.each([
    { name: "t.me URL", to: "https://t.me/mychannel" },
    { name: "t.me URL (no https)", to: "t.me/mychannel" },
    { name: "valid target (plain chat id)", to: "-1001234567890" },
    { name: "valid target (colon delimiter)", to: "-1001234567890:123" },
    { name: "valid target (topic marker)", to: "-1001234567890:topic:456" },
    { name: "@username", to: "@mybot" },
    { name: "without target", to: undefined },
  ] as const)("accepts Telegram delivery with $name", ({ to }) => {
    const job = createIsolatedAgentTurnJob("job-telegram-valid", {
      mode: "announce",
      channel: "telegram",
      ...(to ? { to } : {}),
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });
});

function createMockState(now: number, opts?: { defaultAgentId?: string }): CronServiceState {
  return {
    deps: {
      nowMs: () => now,
      defaultAgentId: opts?.defaultAgentId,
    },
  } as unknown as CronServiceState;
}

describe("createJob rejects sessionTarget main for non-default agents", () => {
  const now = Date.parse("2026-02-28T12:00:00.000Z");

  const mainJobInput = (agentId?: string) => ({
    name: "my-main-job",
    enabled: true,
    schedule: { kind: "every" as const, everyMs: 60_000 },
    sessionTarget: "main" as const,
    wakeMode: "now" as const,
    payload: { kind: "systemEvent" as const, text: "tick" },
    ...(agentId !== undefined ? { agentId } : {}),
  });

  it.each([
    { name: "default agent", defaultAgentId: "main", agentId: undefined },
    { name: "explicit default agent", defaultAgentId: "main", agentId: "main" },
    { name: "case-insensitive defaultAgentId match", defaultAgentId: "Main", agentId: "MAIN" },
  ] as const)("allows creating a main-session job for $name", ({ defaultAgentId, agentId }) => {
    const state = createMockState(now, { defaultAgentId });
    expect(() => createJob(state, mainJobInput(agentId))).not.toThrow();
  });

  it.each([
    { name: "non-default agentId", defaultAgentId: "main", agentId: "custom-agent" },
    { name: "missing defaultAgentId", defaultAgentId: undefined, agentId: "custom-agent" },
  ] as const)("rejects creating a main-session job for $name", ({ defaultAgentId, agentId }) => {
    const state = createMockState(now, defaultAgentId ? { defaultAgentId } : undefined);
    expect(() => createJob(state, mainJobInput(agentId))).toThrow(
      'cron: sessionTarget "main" is only valid for the default agent',
    );
  });

  it("allows isolated session job for non-default agents", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    expect(() =>
      createJob(state, {
        name: "isolated-job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "do it" },
        agentId: "custom-agent",
      }),
    ).not.toThrow();
  });

  it("rejects custom session targets with path separators", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    expect(() =>
      createJob(state, {
        name: "bad-custom-session",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:../../outside",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hello" },
      }),
    ).toThrow("invalid cron sessionTarget session id");
  });

  it("rejects failureDestination on main jobs without webhook delivery mode", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    expect(() =>
      createJob(state, {
        ...mainJobInput("main"),
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
          failureDestination: {
            mode: "announce",
            channel: "signal",
            to: "+15550001111",
          },
        },
      }),
    ).toThrow('cron channel delivery config is only supported for sessionTarget="isolated"');
  });
});

describe("applyJobPatch rejects sessionTarget main for non-default agents", () => {
  const now = Date.now();

  const createMainJob = (agentId?: string): CronJob => ({
    id: "job-main-agent-check",
    name: "main-agent-check",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    agentId,
  });

  it.each([
    { name: "rejects patching agentId to non-default", agentId: "custom-agent", shouldThrow: true },
    { name: "allows patching agentId to the default agent", agentId: "main", shouldThrow: false },
  ] as const)("$name on a main-session job", ({ agentId, shouldThrow }) => {
    const job = createMainJob();
    const patch = { agentId } as CronJobPatch;
    if (shouldThrow) {
      expect(() => applyJobPatch(job, patch, { defaultAgentId: "main" })).toThrow(
        'cron: sessionTarget "main" is only valid for the default agent',
      );
      return;
    }
    expect(() => applyJobPatch(job, patch, { defaultAgentId: "main" })).not.toThrow();
  });

  it("rejects patching to a custom session target with path separators", () => {
    const job = createMainJob();
    expect(() =>
      applyJobPatch(
        job,
        {
          sessionTarget: "session:..\\outside",
          payload: { kind: "agentTurn", message: "hello" },
        },
        { defaultAgentId: "main" },
      ),
    ).toThrow("invalid cron sessionTarget session id");
  });
});

describe("cron stagger defaults", () => {
  it("defaults top-of-hour cron jobs to 5m stagger", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      name: "hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
    });

    expectCronStaggerMs(job, DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("keeps exact schedules when staggerMs is explicitly 0", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      name: "exact-hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
    });

    expectCronStaggerMs(job, 0);
  });

  it("preserves existing stagger when editing cron expression without stagger", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-keep-stagger",
      name: "job-keep-stagger",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 120_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };

    applyJobPatch(job, {
      schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.expr).toBe("0 */2 * * *");
      expect(job.schedule.staggerMs).toBe(120_000);
    }
  });

  it("applies default stagger when switching from every to top-of-hour cron", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-switch-cron",
      name: "job-switch-cron",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };

    applyJobPatch(job, {
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    }
  });
});

describe("createJob delivery defaults", () => {
  const now = Date.parse("2026-02-28T12:00:00.000Z");

  it('defaults delivery to { mode: "announce" } for isolated agentTurn jobs without explicit delivery', () => {
    const state = createMockState(now);
    const job = createJob(state, {
      name: "isolated-no-delivery",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("preserves explicit delivery for isolated agentTurn jobs", () => {
    const state = createMockState(now);
    const job = createJob(state, {
      name: "isolated-explicit-delivery",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "none" },
    });
    expect(job.delivery).toEqual({ mode: "none" });
  });

  it("does not set delivery for main systemEvent jobs without explicit delivery", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    const job = createJob(state, {
      name: "main-no-delivery",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
    });
    expect(job.delivery).toBeUndefined();
  });

  it("uses legacy systemEvent message text without throwing", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    const job = createJob(state, {
      name: "legacy system event",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", message: "legacy text" } as never,
    });

    expect(resolveJobPayloadTextForMain(job)).toBe("legacy text");
  });
});

describe("recomputeNextRuns", () => {
  it("backfills missing every anchorMs for legacy loaded jobs", () => {
    const now = Date.parse("2026-03-01T12:00:00.000Z");
    const createdAtMs = now - 120_000;
    const job: CronJob = {
      id: "legacy-every",
      name: "legacy-every",
      enabled: true,
      createdAtMs,
      updatedAtMs: createdAtMs,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRuns(state)).toBe(true);
    expect(job.schedule.kind).toBe("every");
    if (job.schedule.kind === "every") {
      expect(job.schedule.anchorMs).toBe(createdAtMs);
    }
    expect(job.state.nextRunAtMs).toBe(now);
  });

  it("repairs future cron nextRunAtMs values that are not schedule slots", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const badFuture = Date.parse("2026-05-12T16:00:00.000Z");
    const expected = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-21-shanghai",
      name: "daily 21 shanghai",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: badFuture },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(true);
    expect(job.state.nextRunAtMs).toBe(expected);
  });

  it("preserves valid future cron nextRunAtMs values during maintenance", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const validFuture = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-valid-future",
      name: "daily valid future",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: validFuture },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(validFuture);
  });

  it("repairs future cron nextRunAtMs values that would fire before the next schedule slot", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const tooEarly = Date.parse("2026-05-05T12:30:00.000Z");
    const expected = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-too-early",
      name: "daily too early",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: tooEarly },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(true);
    expect(job.state.nextRunAtMs).toBe(expected);
  });

  it("preserves deferred agent-turn cron nextRunAtMs values before the next natural slot", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const deferred = Date.parse("2026-05-05T12:02:00.000Z");
    const job: CronJob = {
      id: "daily-deferred-agent-turn",
      name: "daily deferred agent turn",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: { nextRunAtMs: deferred },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(deferred);
  });

  it("preserves cron retry backoff nextRunAtMs values during maintenance", () => {
    const now = Date.parse("2025-12-13T04:02:00.000Z");
    const retryAt = Date.parse("2025-12-13T04:10:00.000Z");
    const job: CronJob = {
      id: "backoff-pending",
      name: "backoff pending",
      enabled: true,
      createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "do not run during backoff" },
      state: {
        nextRunAtMs: retryAt,
        lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
        lastStatus: "error",
        consecutiveErrors: 4,
      },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(retryAt);
  });

  it("preserves cron retry backoff nextRunAtMs values from the run end time", () => {
    const now = Date.parse("2025-12-13T04:10:00.000Z");
    const retryAt = Date.parse("2025-12-13T04:20:30.000Z");
    const job: CronJob = {
      id: "backoff-from-ended-at",
      name: "backoff from ended at",
      enabled: true,
      createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T04:05:30.000Z"),
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "preserve run-end retry backoff" },
      state: {
        nextRunAtMs: retryAt,
        lastRunAtMs: Date.parse("2025-12-13T04:01:30.000Z"),
        lastDurationMs: 4 * 60_000,
        lastStatus: "error",
        consecutiveErrors: 4,
      },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(retryAt);
  });

  it("repairs stale future cron nextRunAtMs values after error backoff has elapsed", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const badFuture = Date.parse("2026-05-12T16:00:00.000Z");
    const expected = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-expired-error",
      name: "daily expired error",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {
        nextRunAtMs: badFuture,
        lastRunAtMs: Date.parse("2026-05-04T00:00:00.000Z"),
        lastStatus: "error",
        consecutiveErrors: 1,
      },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(true);
    expect(job.state.nextRunAtMs).toBe(expected);
  });

  it("does not throw while probing malformed cron schedules with future nextRunAtMs", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const future = Date.parse("2026-05-12T16:00:00.000Z");
    const job: CronJob = {
      id: "malformed-future",
      name: "malformed future",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: future },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(() => recomputeNextRunsForMaintenance(state)).not.toThrow();
    expect(job.state.nextRunAtMs).toBe(future);
    expect(job.state.scheduleErrorCount).toBeUndefined();
  });
});
