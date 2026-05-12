import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  coerceCronDeliveryPreviews,
  getCronChannelOptions,
  parseCronToolsAllow,
  printCronList,
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
  expect(logs).toEqual(expect.arrayContaining([expect.stringContaining(text)]));
}

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
