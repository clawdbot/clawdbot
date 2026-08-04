import { describe, expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";
import { assertSupportedJobSpec, assertTriggerSupport } from "./service/jobs-validation.js";
import { createCronServiceState } from "./service/state.js";
import { executeJobCore } from "./service/timer-execution.js";
import { projectCronJobThroughStorageCodec } from "./store/row-codec.js";

const schedule = { kind: "every", everyMs: 60_000 } as const;

describe("wake cron payload", () => {
  it("normalizes to a main-session payload with no executable fields", () => {
    const normalized = normalizeCronJobCreate({
      name: "host wake",
      schedule,
      payload: {
        kind: "wake",
        text: "system event",
        message: "agent turn",
        model: "provider/model",
        fallbacks: ["provider/fallback"],
        thinking: "high",
        timeoutSeconds: 30,
        lightContext: true,
        allowUnsafeExternalContent: true,
        externalContentSource: "webhook",
        argv: ["sh", "-lc", "echo no"],
        cwd: "/tmp",
        env: { TOKEN: "value" },
        input: "stdin",
        noOutputTimeoutSeconds: 5,
        outputMaxBytes: 1024,
        script: "return true",
        toolBudget: 2,
        toolsAllow: ["exec"],
        toolsAllowIsDefault: true,
      },
    } as never);

    expect(normalized).not.toBeNull();
    if (!normalized) {
      throw new Error("expected normalized wake job");
    }
    expect(normalized.sessionTarget).toBe("main");
    expect(normalized.payload).toEqual({ kind: "wake" });
    expect(
      normalizeCronJobPatch({
        payload: { kind: "wake", message: "ignored", script: "return true" },
      } as never),
    ).toEqual({ payload: { kind: "wake" } });
  });

  it("accepts public create and patch shapes but rejects additional properties", () => {
    const create = {
      name: "host wake",
      schedule,
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "wake" },
    };
    expect(validateCronAddParams(create)).toBe(true);
    expect(validateCronUpdateParams({ id: "job-1", patch: { payload: { kind: "wake" } } })).toBe(
      true,
    );
    expect(
      validateCronAddParams({
        ...create,
        payload: { kind: "wake", message: "must not run" },
      }),
    ).toBe(false);
  });

  it("allows only main-session time schedules without condition triggers", () => {
    const base = makeCronJob({
      schedule,
      sessionTarget: "main",
      payload: { kind: "wake" },
    });
    expect(() => assertSupportedJobSpec(base)).not.toThrow();
    expect(() => assertSupportedJobSpec({ ...base, sessionTarget: "isolated" })).toThrow(
      /isolated cron jobs require/,
    );
    expect(() =>
      assertSupportedJobSpec({
        ...base,
        schedule: { kind: "stream", command: ["tail", "-f", "events"] },
      }),
    ).toThrow(/at, every, or cron/);
    expect(() =>
      assertSupportedJobSpec({
        ...base,
        schedule: { kind: "on-exit", command: "build" },
      }),
    ).toThrow(/at, every, or cron/);
    expect(() =>
      assertTriggerSupport({
        ...base,
        trigger: { script: "json({ fire: true })" },
      }),
    ).toThrow(/cannot use condition triggers/);
  });

  it("round-trips through SQLite and validates the persisted shape", () => {
    const job = makeCronJob({
      schedule,
      sessionTarget: "main",
      payload: { kind: "wake" },
    });
    const projected = projectCronJobThroughStorageCodec(job);
    expect(projected.payload).toEqual({ kind: "wake" });
    expect(getInvalidPersistedCronJobReason(projected)).toBeNull();
    expect(
      getInvalidPersistedCronJobReason({
        ...projected,
        schedule: { kind: "stream", command: ["tail", "-f", "events"] },
      }),
    ).toBe("invalid-payload");
    expect(
      getInvalidPersistedCronJobReason({
        ...projected,
        trigger: { script: "json({ fire: true })" },
      }),
    ).toBe("invalid-payload");
  });

  it("returns before every executable dependency, including trigger evaluation", async () => {
    const evaluateCronTrigger = vi.fn();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runHeartbeatOnce = vi.fn();
    const runCommandJob = vi.fn();
    const runScriptJob = vi.fn();
    const runIsolatedAgentJob = vi.fn();
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-wake-payload-test.sqlite",
      cronEnabled: true,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      evaluateCronTrigger,
      enqueueSystemEvent,
      requestHeartbeat,
      runHeartbeatOnce,
      runCommandJob,
      runScriptJob,
      runIsolatedAgentJob,
    });
    const job = makeCronJob({
      schedule,
      sessionTarget: "main",
      payload: { kind: "wake" },
      trigger: { script: "json({ fire: true })" },
    });

    await expect(executeJobCore(state, job)).resolves.toEqual({
      status: "ok",
      summary: "wake-only occurrence",
    });
    for (const executable of [
      evaluateCronTrigger,
      enqueueSystemEvent,
      requestHeartbeat,
      runHeartbeatOnce,
      runCommandJob,
      runScriptJob,
      runIsolatedAgentJob,
    ]) {
      expect(executable).not.toHaveBeenCalled();
    }
  });
});
