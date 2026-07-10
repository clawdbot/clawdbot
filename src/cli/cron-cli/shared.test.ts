// Cron shared tests cover shared cron CLI parsing, display, and error helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import type { CronJob } from "../../cron/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  coerceCronDeliveryPreviews,
  enrichCronJsonWithStatus,
  getCronChannelOptions,
  parseAt,
  parseCronToolsAllow,
  parseDurationMs,
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
    log: (msg: string) => logs.push(msg),
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
  it("falls back to a generic channel placeholder when no plugins are loaded", () => {
    hoisted.listChannelPluginsMock.mockReturnValue([]);
    expect(getCronChannelOptions()).toBe("last|<channel-id>");
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

describe("parseDurationMs", () => {
  it("parses valid positive durations", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("1.5h")).toBe(5_400_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  it("rejects non-positive and malformed durations", () => {
    expect(parseDurationMs("0s")).toBeNull();
    expect(parseDurationMs("0.5ms")).toBeNull();
    expect(parseDurationMs("0.001ms")).toBeNull();
    expect(parseDurationMs("-5s")).toBeNull();
    expect(parseDurationMs("abc")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
  });

  it("rejects durations that overflow to a non-finite millisecond value (#83906)", () => {
    // A finite mantissa can still overflow once multiplied by a large unit factor.
    expect(parseDurationMs(`1${"0".repeat(302)}d`)).toBeNull();
    // A large-but-finite result is still accepted.
    expect(parseDurationMs(`9${"0".repeat(15)}ms`)).toBe(9_000_000_000_000_000);
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
