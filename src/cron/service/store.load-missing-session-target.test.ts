import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { assertSupportedJobSpec, findJobOrThrow } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-missing-session-target-",
});

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storePath: string, job: Record<string, unknown>) {
  await writeJobStore(storePath, [job]);
}

async function writeJobStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf8");
}

function createStoreTestState(storePath: string) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("cron service store load: missing sessionTarget", () => {
  it("hydrates flat legacy cron rows before recomputing next runs", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "legacy-flat-cron",
      name: "dbus-watchdog",
      kind: "cron",
      cron: "*/10 * * * *",
      tz: "UTC",
      session: "isolated",
      message: "watch dbus",
      tools: ["exec"],
      enabled: true,
      created_at: "2026-04-17T20:09:00Z",
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);

    const job = findJobOrThrow(state, "legacy-flat-cron");
    expect(job.schedule).toEqual({
      kind: "cron",
      expr: "*/10 * * * *",
      tz: "UTC",
    });
    expect(job.sessionTarget).toBe("isolated");
    expect(job.payload).toEqual({
      kind: "agentTurn",
      message: "watch dbus",
      toolsAllow: ["exec"],
    });
    expect(job.state.nextRunAtMs).toBeGreaterThan(STORE_TEST_NOW);
    expect(assertSupportedJobSpec(job)).toBeUndefined();
  });

  it('defaults missing sessionTarget to "main" for systemEvent payloads', async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "missing-session-target-system-event",
      name: "missing session target system event",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);

    const job = findJobOrThrow(state, "missing-session-target-system-event");
    expect(job.sessionTarget).toBe("main");
    expect(assertSupportedJobSpec(job)).toBeUndefined();
  });

  it('defaults missing sessionTarget to "isolated" for agentTurn payloads', async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "missing-session-target-agent-turn",
      name: "missing session target agent turn",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      state: {},
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);

    const job = findJobOrThrow(state, "missing-session-target-agent-turn");
    expect(job.sessionTarget).toBe("isolated");
    expect(assertSupportedJobSpec(job)).toBeUndefined();
  });

  it("assertSupportedJobSpec throws a clear error when sessionTarget is missing", () => {
    const bogus = {
      payload: { kind: "agentTurn" as const, message: "ping" },
    } as unknown as Parameters<typeof assertSupportedJobSpec>[0];
    expect(() => assertSupportedJobSpec(bogus)).toThrow(/missing sessionTarget/);
  });

  it("skips malformed persisted schedule and payload shapes without rewriting the store", async () => {
    const { storePath } = await makeStorePath();

    await writeJobStore(storePath, [
      {
        id: "valid-job",
        name: "valid job",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
      {
        id: "bad-schedule",
        name: "bad schedule",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: ["every", 60_000],
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
      {
        id: "bad-payload",
        name: "bad payload",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: ["systemEvent", "tick"],
        state: {},
      },
      {
        id: "bad-cron-expr",
        name: "bad cron expr",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "cron", expr: [] },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
      {
        id: "bad-system-event-text",
        name: "bad system event text",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: ["tick"] },
        state: {},
      },
      {
        id: "bad-agent-turn-message",
        name: "bad agent turn message",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: { text: "tick" } },
        state: {},
      },
    ]);
    const beforeRaw = await fs.readFile(storePath, "utf-8");
    const warnSpy = vi.spyOn(logger, "warn");

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    await ensureLoaded(state, { forceReload: true });

    expect(state.store?.jobs.map((job) => job.id)).toEqual(["valid-job"]);
    expect(findJobOrThrow(state, "valid-job").state.nextRunAtMs).toBe(STORE_TEST_NOW);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toBe(beforeRaw);

    const invalidShapeWarns = warnSpy.mock.calls.filter((call) => {
      const msg = typeof call[1] === "string" ? call[1] : "";
      return msg.includes("skipped invalid persisted job");
    });
    expect(invalidShapeWarns).toHaveLength(5);
    expect(invalidShapeWarns.map((call) => (call[0] as { reason?: string }).reason)).toEqual([
      "missing-schedule",
      "missing-payload",
      "invalid-schedule",
      "invalid-payload",
      "invalid-payload",
    ]);
    warnSpy.mockRestore();
  });

  it("warns once per jobId across repeated forceReload cycles", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "log-dedupe-target",
      name: "log dedupe target",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      state: {},
    });

    const warnSpy = vi.spyOn(logger, "warn");
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);
    await ensureLoaded(state, { forceReload: true });
    await ensureLoaded(state, { forceReload: true });

    const missingSessionTargetWarns = warnSpy.mock.calls.filter((call) => {
      const msg = typeof call[1] === "string" ? call[1] : "";
      return msg.includes("missing sessionTarget");
    });
    expect(missingSessionTargetWarns).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
