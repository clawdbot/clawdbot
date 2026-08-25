// Cron shared tests cover shared cron CLI parsing, display, and error helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveCronCreateScheduleFromArgs } from "./schedule-options.js";
import {
  coerceCronDeliveryPreviews,
  enrichCronJsonWithStatus,
  getCronChannelOptions,
  handleCronCliError,
  parseAt,
  parseCronToolsAllow,
  parsePositiveCronDurationMs,
  printCronList,
  printCronShow,
} from "./shared.js";

const hoisted = vi.hoisted(() => ({
  listChannelPluginsMock: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: hoisted.listChannelPluginsMock,
}));

function createRuntimeLogCapture(): { logs: string[]; runtime: RuntimeEnv } {
  const logs: string[] = [];
  const runtime = {
    log: (msg: string) => logs.push(...msg.split("\n")),
    error: () => {},
    exit: () => {},
  } as RuntimeEnv;
  return { logs, runtime };
}

function expectLogsToInclude(logs: readonly string[], text: string): void {
  expect(logs.join("\n")).toContain(text);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handleCronCliError", () => {
  it("renders typed automation lookup misses with the cron list recovery command", () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "transport-neutral lookup miss",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
    const errorOutput = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    expect(() => handleCronCliError(error)).toThrow("exit 1");
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining(
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
      ),
    );
    errorOutput.mockRestore();
    exit.mockRestore();
  });
});

function createBaseJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-id",
    agentId: "main",
    name: "Test Job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3600000).toISOString() },
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: { nextRunAtMs: now + 3600000 },
    ...overrides,
  } as CronJob;
}

describe("printCronList", () => {
  beforeEach(() => {
    hoisted.listChannelPluginsMock.mockReset();
    hoisted.listChannelPluginsMock.mockReturnValue([]);
  });

  it("handles job with undefined sessionTarget (#9649)", () => {
    const { logs, runtime } = createRuntimeLogCapture();

    // Simulate a job without sessionTarget (as reported in #9649)
    const jobWithUndefinedTarget = createBaseJob({
      id: "test-job-id",
      // sessionTarget is intentionally omitted to simulate the bug
    });

    printCronList([jobWithUndefinedTarget], runtime);

    // Verify output contains the job
    expect(logs.length).toBeGreaterThan(1);
    expectLogsToInclude(logs, "test-job-id");
  });

  it("handles job with defined sessionTarget", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const jobWithTarget = createBaseJob({
      id: "test-job-id-2",
      name: "Test Job 2",
      sessionTarget: "isolated",
    });

    printCronList([jobWithTarget], runtime);
    expectLogsToInclude(logs, "isolated");
  });

  it.each([
    [59_999, "<1m"],
    [60_000, "1m"],
    [3_569_000, "59m"],
    [3_570_000, "1h"],
    [84_599_000, "23h"],
    [84_600_000, "1d"],
  ])("renders %i ms as %s across cron list and show", (deltaMs, expected) => {
    vi.useFakeTimers();
    const now = new Date("2026-08-02T12:00:00.000Z");
    vi.setSystemTime(now);
    const job = createBaseJob({
      id: "rounding-job",
      state: {
        nextRunAtMs: now.getTime() + deltaMs,
        lastRunAtMs: now.getTime() - deltaMs,
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    const row = list.logs.find((line) => line.includes(job.id)) ?? "";
    expect(row).toContain(`in ${expected}`);
    expect(row).toContain(`${expected} ago`);

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expect(show.logs).toContain(`next: in ${expected}`);
    expect(show.logs).toContain(`last: ${expected} ago`);
  });

  it("truncates and aligns names by sanitized terminal display width", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const prefix19 = "x".repeat(19);
    const prefix20 = "x".repeat(20);
    const prefix21 = "x".repeat(21);
    const injectedMarker = "cron-table-injection";
    const injectedControl = `\u001B]0;${injectedMarker}\u0007`;
    const cases = [
      { name: `${prefix20}🚀tail`, expected: `${prefix20}...` },
      { name: `${prefix21}Atail`, expected: `${prefix21}...` },
      { name: `${prefix19}表tail`, expected: `${prefix19}表...` },
      { name: `${prefix20}e\u0301tail`, expected: `${prefix20}e\u0301...` },
      { name: `${prefix19}👨‍👩‍👧‍👦tail`, expected: `${prefix19}👨‍👩‍👧‍👦...` },
      { name: `${prefix20}👨‍👩‍👧‍👦`, expected: `${prefix20}👨‍👩‍👧‍👦` },
      { name: `${prefix20}${injectedControl}🚀tail`, expected: `${prefix20}...` },
    ];

    printCronList(
      cases.map(({ name }, index) => createBaseJob({ id: `unicode-name-${index}`, name })),
      runtime,
    );

    const header = logs[0] ?? "";
    const rows = logs.slice(1);
    const scheduleColumn = visibleWidth(header.slice(0, header.indexOf("Schedule")));
    expect(rows).toHaveLength(cases.length);
    for (const [index, row] of rows.entries()) {
      const scheduleIndex = row.indexOf("at ");
      expect(scheduleIndex).toBeGreaterThan(-1);
      expect(visibleWidth(row.slice(0, scheduleIndex))).toBe(scheduleColumn);
      expect(row).toContain(cases[index]?.expected);
    }
    const output = logs.join("\n");
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    expect(output).not.toContain("\uFFFD");
    expect(output).not.toContain(injectedMarker);
  });

  it.each([
    ["halfwidth voiced kana", `${"x".repeat(23)}ﾊﾞ`, `${"x".repeat(21)}...`],
    ["halfwidth semi-voiced kana", `${"x".repeat(23)}ﾊﾟ`, `${"x".repeat(21)}...`],
    ["zero-width space", `${"x".repeat(23)}\u200B`, `${"x".repeat(23)}\u200B `],
    ["word joiner", `${"x".repeat(23)}\u2060`, `${"x".repeat(23)}\u2060 `],
    ["zero-width no-break space", `${"x".repeat(23)}\uFEFF`, `${"x".repeat(23)}\uFEFF `],
    ["leading zero-width non-joiner", `\u200C${"x".repeat(23)}`, `\u200C${"x".repeat(23)} `],
    ["Hindi spacing mark", `${"x".repeat(23)}का`, `${"x".repeat(21)}...`],
    ["repeated Hangul jamo", `${"x".repeat(22)}ᄀ가`, `${"x".repeat(21)}...`],
    ["Hangul leading filler", `${"x".repeat(23)}\u115F`, `${"x".repeat(21)}...`],
    ["Hangul compatibility filler", `${"x".repeat(23)}\u3164`, `${"x".repeat(21)}...`],
    ["halfwidth Hangul filler", `${"x".repeat(23)}\uFFA0`, `${"x".repeat(23)}\uFFA0`],
    ["zero-width Hangul vowel filler", `${"x".repeat(23)}\u1160`, `${"x".repeat(23)}\u1160 `],
    ["lone high surrogate", `${"x".repeat(23)}\uD800`, `${"x".repeat(23)}\uD800`],
    ["lone low surrogate", `${"x".repeat(23)}\uDC00`, `${"x".repeat(23)}\uDC00`],
  ])("aligns the %s name cell without relying on its width helper", (_label, name, expected) => {
    const { logs, runtime } = createRuntimeLogCapture();
    printCronList([createBaseJob({ name })], runtime);

    const [header = "", row = ""] = logs;
    const nameColumn = header.indexOf("Name");
    const scheduleColumn = row.indexOf("at ");
    expect(nameColumn).toBeGreaterThan(-1);
    expect(scheduleColumn).toBeGreaterThan(nameColumn);
    expect(row.slice(nameColumn, scheduleColumn - 1)).toBe(expected);
  });

  it("sanitizes and bounds named-session targets", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const injectedMarker = "cron-target-injection";
    const sessionTarget = `session:${"x".repeat(20)}\u001B]0;${injectedMarker}\u0007`;
    const job = createBaseJob({
      id: "target-job",
      sessionTarget: sessionTarget as CronJob["sessionTarget"],
    });

    printCronList([job], runtime, {
      deliveryPreviews: new Map([[job.id, { label: "target-delivery", detail: "destination" }]]),
    });

    const header = logs[0] ?? "";
    const row = logs[1] ?? "";
    const deliveryColumn = visibleWidth(header.slice(0, header.indexOf("Delivery")));
    const deliveryIndex = row.indexOf("target-delivery");
    expect(deliveryIndex).toBeGreaterThan(-1);
    expect(visibleWidth(row.slice(0, deliveryIndex))).toBe(deliveryColumn);
    expect(row).toContain("sessio...");
    expect(row).not.toContain(injectedMarker);
  });

  it("shows declaration metadata and existing run status", () => {
    const job = createBaseJob({
      declarationKey: "daily-report",
      displayName: "Daily summary",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      sessionTarget: "isolated",
      state: {
        nextRunAtMs: Date.now() + 60_000,
        lastRunAtMs: Date.now() - 60_000,
        lastRunStatus: "error",
        lastError: "boom",
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: "offline",
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    expect(list.logs[0]).toContain("Declaration");
    expect(list.logs[0]).toContain("Owner");
    expectLogsToInclude(list.logs, "daily-report");
    expectLogsToInclude(list.logs, "Daily summary");
    expectLogsToInclude(list.logs, "agent:ops:main");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "declaration: daily-report");
    expectLogsToInclude(show.logs, "display name: Daily summary");
    expectLogsToInclude(show.logs, "owner agent: ops");
    expectLogsToInclude(show.logs, "last error: boom");
    expectLogsToInclude(show.logs, "last delivery: not-delivered");
    expectLogsToInclude(show.logs, "last delivery error: offline");
  });

  it("sanitizes every stored cron show value at the terminal boundary", () => {
    const control = "\u001B]0;cron-show-injection\u0007";
    const injected = (value: string) => `${control}${value}\r\nforged-row\tfield`;
    const job = createBaseJob({
      id: injected("job-id"),
      declarationKey: injected("declaration"),
      name: injected("name 🦞"),
      displayName: injected("display"),
      owner: { agentId: injected("owner"), sessionKey: injected("owner-session") },
      agentId: injected("agent"),
      sessionTarget: injected("session") as CronJob["sessionTarget"],
      payload: { kind: "agentTurn", message: "test", model: injected("model") },
      state: {
        lastError: injected("last-error"),
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: injected("delivery-error"),
        lastDiagnosticSummary: injected("diagnostic"),
      },
    });
    const { logs, runtime } = createRuntimeLogCapture();

    printCronShow(job, runtime, {
      deliveryPreview: { label: injected("delivery"), detail: injected("detail") },
    });

    const output = logs.join("\n");
    expect(output).not.toContain("\u001B");
    expect(output).not.toContain("\nforged-row");
    expect(output).toContain("\\r\\nforged-row\\tfield");
    expect(output).toContain("name 🦞");
  });

  it("tolerates malformed rows in human-readable output", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const malformedJob = {
      id: "malformed-job",
      name: undefined,
      enabled: true,
      sessionTarget: undefined,
      payload: undefined,
      schedule: undefined,
      state: undefined,
    } as unknown as CronJob;

    printCronList([malformedJob], runtime);
    expectLogsToInclude(logs, "malformed-job");
  });

  it("shows stagger label for cron schedules", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "staggered-job",
      name: "Staggered",
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 5 * 60_000 },
      sessionTarget: "main",
      state: {},
      payload: { kind: "systemEvent", text: "tick" },
    });

    printCronList([job], runtime);
    expectLogsToInclude(logs, "(stagger 5m)");
  });

  it("marks trigger schedules and shows evaluation details", () => {
    const job = createBaseJob({
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: "json({ fire: true })", once: true },
      state: {
        triggerEvalCount: 4,
        lastTriggerEvalAtMs: Date.now() - 30_000,
        lastTriggerFireAtMs: Date.now() - 60_000,
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    expectLogsToInclude(list.logs, "every 30s+trigger");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "trigger: once=yes; evals=4;");
  });

  it("shows on-exit schedules in list and show output", () => {
    const job = createBaseJob({
      id: "on-exit-job",
      name: "Watch build",
      schedule: { kind: "on-exit", command: "pnpm build", cwd: "/repo" },
      sessionTarget: "main",
      state: {},
      payload: { kind: "systemEvent", text: "done" },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    expectLogsToInclude(list.logs, "on-exit pnpm build @ /repo");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "schedule: on-exit pnpm build @ /repo");
  });

  it("shows the consecutive failure count for chronically failing jobs", () => {
    const failing = createBaseJob({
      id: "failing-job",
      name: "Failing",
      state: { lastRunStatus: "error", consecutiveErrors: 12, lastError: "boom" },
    });
    const singleFailure = createBaseJob({
      id: "single-failure-job",
      name: "Failed Once",
      state: { lastRunStatus: "error", consecutiveErrors: 1, lastError: "boom" },
    });

    const { logs, runtime } = createRuntimeLogCapture();
    printCronList([failing, singleFailure], runtime);

    expectLogsToInclude(logs, "error (12x)");
    // A single failure keeps the bare status token; the count only marks repeats.
    const singleLine = logs.find((line) => line.includes("single-failure-job")) ?? "";
    expect(singleLine).toContain("error");
    expect(singleLine).not.toContain("(1x)");
  });

  it.each([
    { label: "required", bestEffort: false },
    { label: "best-effort", bestEffort: true },
    { label: "default", bestEffort: undefined },
  ])(
    "makes $label undelivered automation output visible without changing JSON status",
    ({ bestEffort }) => {
      const job = createBaseJob({
        id: "undelivered-job",
        delivery: {
          mode: "announce",
          ...(bestEffort === undefined ? {} : { bestEffort }),
        },
        state: {
          lastRunStatus: "ok",
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: "primary route rejected",
        },
      });

      const list = createRuntimeLogCapture();
      printCronList([job], list.runtime);
      expectLogsToInclude(list.logs, "ok (not delivered)");

      const show = createRuntimeLogCapture();
      printCronShow(job, show.runtime);
      expectLogsToInclude(show.logs, "status: ok (not delivered)");
      expectLogsToInclude(show.logs, "last delivery error: primary route rejected");

      expect(enrichCronJsonWithStatus(job)).toMatchObject({
        status: "ok",
        state: { lastRunStatus: "ok", lastDeliveryStatus: "not-delivered" },
      });
      expect(enrichCronJsonWithStatus({ jobs: [job] })).toMatchObject({
        jobs: [{ status: "ok" }],
      });
    },
  );

  it.each([
    { label: "disabled", enabled: false, runStatus: "ok" as const, expectedStatus: "disabled" },
    { label: "running", enabled: true, runStatus: "ok" as const, expectedStatus: "running" },
    { label: "failed", enabled: true, runStatus: "error" as const, expectedStatus: "error" },
  ])(
    "does not let prior non-delivery override a $label automation",
    ({ enabled, runStatus, expectedStatus }) => {
      const job = createBaseJob({
        enabled,
        state: {
          lastRunStatus: runStatus,
          lastDeliveryStatus: "not-delivered",
          ...(expectedStatus === "running" ? { runningAtMs: Date.now() } : {}),
        },
      });

      const show = createRuntimeLogCapture();
      printCronShow(job, show.runtime);

      expectLogsToInclude(show.logs, `status: ${expectedStatus}`);
      expect(show.logs.join("\n")).not.toContain("ok (not delivered)");
      expect(enrichCronJsonWithStatus(job)).toMatchObject({ status: expectedStatus });
    },
  );

  it("shows why the scheduler auto-disabled a job without changing JSON status", () => {
    const runFailures = createBaseJob({
      id: "auto-disabled-runs",
      name: "Auto-disabled runs",
      enabled: false,
      state: {
        consecutiveErrors: 10,
        autoDisabled: {
          reason: "consecutive-failures",
          atMs: Date.now(),
          consecutiveErrors: 10,
        },
      },
    });
    const scheduleErrors = createBaseJob({
      id: "auto-disabled-schedule",
      name: "Auto-disabled schedule",
      enabled: false,
      state: {
        scheduleErrorCount: 3,
        autoDisabled: {
          reason: "schedule-errors",
          atMs: Date.now(),
          consecutiveErrors: 3,
        },
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([runFailures, scheduleErrors], list.runtime);
    expectLogsToInclude(list.logs, "disabled (10x)");
    expectLogsToInclude(list.logs, "disabled (schedule)");

    const show = createRuntimeLogCapture();
    printCronShow(runFailures, show.runtime);
    expectLogsToInclude(show.logs, "status: disabled (10x)");

    expect(enrichCronJsonWithStatus(runFailures)).toMatchObject({
      status: "disabled",
      state: {
        autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
      },
    });
  });

  it("caps the failure count so the status column never overflows", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    printCronList(
      [
        createBaseJob({
          id: "minute-cron-job",
          state: { lastRunStatus: "error", consecutiveErrors: 1440, lastError: "boom" },
        }),
      ],
      runtime,
    );
    expectLogsToInclude(logs, "error (99+x)");
    expect(logs.join("\n")).not.toContain("1440");
  });

  it("keeps the --json status field free of the failure-count decoration", () => {
    const job = createBaseJob({
      id: "json-job",
      state: { lastRunStatus: "error", consecutiveErrors: 12, lastError: "boom" },
    });
    const enriched = enrichCronJsonWithStatus({
      jobs: [job],
    }) as { jobs: Array<{ status?: string }> };
    expect(enriched.jobs[0]?.status).toBe("error");
    expect(enrichCronJsonWithStatus(job)).toMatchObject({
      status: "error",
      state: { consecutiveErrors: 12, lastError: "boom" },
    });
  });

  it("shows last error and failure count in cron show output", () => {
    const failing = createRuntimeLogCapture();
    printCronShow(
      createBaseJob({
        id: "show-failing-job",
        state: { lastRunStatus: "error", consecutiveErrors: 3, lastError: "provider exploded" },
      }),
      failing.runtime,
    );
    expectLogsToInclude(failing.logs, "status: error (3x)");
    expectLogsToInclude(failing.logs, "last error: provider exploded");

    const healthy = createRuntimeLogCapture();
    printCronShow(
      createBaseJob({ id: "healthy-job", state: { lastRunStatus: "ok" } }),
      healthy.runtime,
    );
    expectLogsToInclude(healthy.logs, "status: ok");
    expectLogsToInclude(healthy.logs, "last error: -");
  });

  it("shows dash for unset agentId instead of default", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "no-agent-job",
      name: "No Agent",
      agentId: undefined,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello", model: "sonnet" },
    });

    printCronList([job], runtime);
    // Header should say "Agent ID" not "Agent"
    expect(logs[0]).toContain("Agent ID");
    // Data row should show "-" for missing agentId, not "default"
    const dataLine = logs[1] ?? "";
    expect(dataLine).not.toContain("default");
  });

  it("shows Model column with payload.model for agentTurn jobs", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "model-job",
      name: "With Model",
      agentId: "ops",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello", model: "sonnet" },
    });

    printCronList([job], runtime);
    expect(logs[0]).toContain("Model");
    const dataLine = logs[1] ?? "";
    expect(dataLine).toContain("sonnet");
  });

  it("shows delivery preview when provided", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "delivery-job",
      name: "Delivery",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello" },
    });

    printCronList([job], runtime, {
      deliveryPreviews: new Map([
        [
          "delivery-job",
          {
            label: "announce -> telegram:-100",
            detail: "resolved from last, main session",
          },
        ],
      ]),
    });

    expect(logs[0]).toContain("Delivery");
    expect(logs[1]).toContain("announce -> telegram:-100");
    expect(logs[1]).toContain("resolved from last");
  });

  it("shows dash in Model column for systemEvent jobs", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "sys-event-job",
      name: "System Event",
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
    });

    printCronList([job], runtime);
    expect(logs[0]).toContain("Model");
  });

  it("shows dash in Model column for agentTurn jobs without model override", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "no-model-job",
      name: "No Model",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello" },
    });

    printCronList([job], runtime);
    const dataLine = logs[1] ?? "";
    expect(dataLine).not.toContain("undefined");
  });

  it("shows explicit agentId when set", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "agent-set-job",
      name: "Agent Set",
      agentId: "ops",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello", model: "opus" },
    });

    printCronList([job], runtime);
    const dataLine = logs[1] ?? "";
    expect(dataLine).toContain("ops");
    expect(dataLine).toContain("opus");
  });

  it("shows exact label for cron schedules with stagger disabled", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "exact-job",
      name: "Exact",
      schedule: { kind: "cron", expr: "0 7 * * *", staggerMs: 0 },
      sessionTarget: "main",
      state: {},
      payload: { kind: "systemEvent", text: "tick" },
    });

    printCronList([job], runtime);
    expectLogsToInclude(logs, "(exact)");
  });
});

describe("parseAt", () => {
  it.each([
    ["2026-03-23", "Asia/Shanghai", "2026-03-22T16:00:00.000Z"],
    ["2026-03-23", "America/New_York", "2026-03-23T04:00:00.000Z"],
    ["2026-03-23T00:00:00", "UTC", "2026-03-23T00:00:00.000Z"],
    ["2026-03-23T00:30:00.250", "UTC", "2026-03-23T00:30:00.250Z"],
    ["2026-03-23T00:30:00", "Europe/Oslo", "2026-03-22T23:30:00.000Z"],
    ["2026-03-23t23:00:00", "Europe/Oslo", "2026-03-23T22:00:00.000Z"],
    ["2026-03-23T23:00:00", "Europe/Oslo", "2026-03-23T22:00:00.000Z"],
    ["2026-03-29T01:30:00", "Europe/Oslo", "2026-03-29T00:30:00.000Z"],
    ["2026-03-29T02:30:00", "Europe/Oslo", null],
    ["2026-10-25T02:30:00", "Europe/Oslo", "2026-10-25T00:30:00.000Z"],
    ["2026-11-01T01:30:00", "America/New_York", "2026-11-01T05:30:00.000Z"],
    ["2026-04-05T01:45:00", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z"],
    ["2027-02-28T24:00:00", "UTC", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00", "Europe/Oslo", "2027-02-28T23:00:00.000Z"],
    ["2027-02-28t24:00:00.000", "America/New_York", "2027-03-01T05:00:00.000Z"],
    ["2027-02-28t24:00:00+05:45", "Europe/Oslo", "2027-02-28T18:15:00.000Z"],
    ["2027-02-28t24:00:00.001", "UTC", null],
    ["2027-09-04t24:00", "America/Santiago", null],
  ])("interprets offsetless one-shot %s in %s", (input, timezone, expected) => {
    expect(parseAt(input, timezone)).toBe(expected);
    if (expected !== null) {
      expect(resolveCronCreateScheduleFromArgs({ at: input, tz: timezone })).toEqual({
        kind: "at",
        at: expected,
      });
    }
  });

  it("keeps date-only one-shot schedules in UTC without an explicit timezone", () => {
    expect(parseAt("2026-03-23")).toBe("2026-03-23T00:00:00.000Z");
    expect(resolveCronCreateScheduleFromArgs({ at: "2026-03-23" })).toEqual({
      kind: "at",
      at: "2026-03-23T00:00:00.000Z",
    });
  });

  it("accepts leading plus relative durations for cron add --at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));

    expect(parseAt("+30m")).toBe("2026-05-25T00:30:00.000Z");
    expect(parseAt("30m")).toBe("2026-05-25T00:30:00.000Z");
  });

  it("rejects out-of-range epoch milliseconds", () => {
    expect(parseAt(String(Number.MAX_SAFE_INTEGER))).toBeNull();
  });

  it("rejects relative durations outside the Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));

    expect(parseAt("+999999999999999999d")).toBeNull();
  });

  it("rejects relative durations when the current clock is at the Date boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    expect(parseAt("+1m")).toBeNull();
  });
});

describe("getCronChannelOptions", () => {
  it("falls back to a channel plugin id placeholder when no plugins are loaded", () => {
    hoisted.listChannelPluginsMock.mockReturnValue([]);
    expect(getCronChannelOptions()).toBe("last|<channel-plugin-id>");
  });

  it("lists discovered channel plugin ids when plugins are available", () => {
    hoisted.listChannelPluginsMock.mockReturnValue([{ id: "quietchat" }, { id: "forum" }]);
    expect(getCronChannelOptions()).toBe("last|quietchat|forum");
  });
});

describe("parseCronToolsAllow", () => {
  it.each([
    { input: "exec,read,write", expected: ["exec", "read", "write"] },
    { input: "exec, read, write", expected: ["exec", "read", "write"] },
    { input: "exec read write", expected: ["exec", "read", "write"] },
    { input: " exec  read,write ", expected: ["exec", "read", "write"] },
    { input: ["exec", "read", "write"], expected: ["exec", "read", "write"] },
  ])("parses $input", ({ input, expected }) => {
    expect(parseCronToolsAllow(input)).toEqual(expected);
  });

  it("returns undefined for empty input", () => {
    expect(parseCronToolsAllow(" ,  ")).toBeUndefined();
  });
});

describe("coerceCronDeliveryPreviews", () => {
  it("keeps gateway-provided preview entries", () => {
    expect(
      coerceCronDeliveryPreviews({
        deliveryPreviews: {
          job1: { label: "announce -> telegram:123", detail: "explicit" },
        },
      }).get("job1"),
    ).toEqual({ label: "announce -> telegram:123", detail: "explicit" });
  });

  it("drops malformed preview entries", () => {
    expect(
      coerceCronDeliveryPreviews({
        deliveryPreviews: {
          job1: { label: "announce -> telegram:123" },
        },
      }).size,
    ).toBe(0);
  });
});

describe("parsePositiveCronDurationMs", () => {
  it("parses valid positive durations", () => {
    expect(parsePositiveCronDurationMs("500ms")).toBe(500);
    expect(parsePositiveCronDurationMs("30s")).toBe(30_000);
    expect(parsePositiveCronDurationMs("1.5h")).toBe(5_400_000);
    expect(parsePositiveCronDurationMs("1h30m")).toBe(5_400_000);
    expect(parsePositiveCronDurationMs("1d")).toBe(86_400_000);
  });

  it("rejects non-positive and malformed durations", () => {
    expect(parsePositiveCronDurationMs("0s")).toBeNull();
    expect(parsePositiveCronDurationMs("0.5ms")).toBe(1);
    expect(parsePositiveCronDurationMs("0.001ms")).toBeNull();
    expect(parsePositiveCronDurationMs("-5s")).toBeNull();
    expect(parsePositiveCronDurationMs("abc")).toBeNull();
    expect(parsePositiveCronDurationMs("")).toBeNull();
  });

  it("rejects durations that overflow to a non-finite millisecond value (#83906)", () => {
    // A finite mantissa can still overflow once multiplied by a large unit factor.
    expect(parsePositiveCronDurationMs(`1${"0".repeat(302)}d`)).toBeNull();
    // A large-but-finite result is still accepted.
    expect(parsePositiveCronDurationMs(`9${"0".repeat(15)}ms`)).toBe(9_000_000_000_000_000);
  });
});

describe("cron status rendering", () => {
  beforeEach(() => {
    hoisted.listChannelPluginsMock.mockReset();
    hoisted.listChannelPluginsMock.mockReturnValue([]);
  });

  // `lastRunStatus` is the primary execution-status field (`lastStatus` is the
  // deprecated alias). The human `cron list`/`cron show` output must resolve it
  // the same way the `--json` status field does, instead of showing "idle".
  it("renders lastRunStatus (matching the --json status), not idle, when lastStatus is unset", () => {
    const now = Date.now();
    const job = createBaseJob({
      id: "status-job",
      sessionTarget: "isolated",
      state: { nextRunAtMs: now + 3_600_000, lastRunStatus: "ok" },
    });

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "status: ok");
    expect(show.logs.join("\n")).not.toContain("status: idle");

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    const dataLine = list.logs.find((line) => line.includes("status-job")) ?? "";
    expect(dataLine).toContain("ok");
    expect(dataLine).not.toContain("idle");

    // The computed --json status must agree with the human render.
    expect(enrichCronJsonWithStatus(job)).toMatchObject({ status: "ok" });
  });
});
