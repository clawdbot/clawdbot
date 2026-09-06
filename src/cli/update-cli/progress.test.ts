import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { defaultRuntime } from "../../runtime.js";
import { createUpdateProgress, printResult } from "./progress.js";

vi.mock("../../infra/update-run-ledger.js", () => ({ getUpdateRun: vi.fn() }));

const runId = "6631ecee-adbf-41e8-a0e3-1b88b28b0a59";
const context = { runId, env: { OPENCLAW_STATE_DIR: "/isolated/update-progress" } };
const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
const result = { runId, status: "ok" as const, mode: "git" as const, steps: [], durationMs: 1200 };

function runRecord(): UpdateRunRecord {
  return {
    runId,
    createdAtMs: 100,
    updatedAtMs: 100,
    trigger: "cli",
    status: "running",
    phase: "requested",
    reason: null,
    before: { version: "2026.9.2" },
    after: {},
    target: { version: "2026.9.3" },
    origin: {},
    steps: [{ step: "requested", status: "in_progress", startedAtMs: 100 }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
  };
}

describe("update progress", () => {
  let run: UpdateRunRecord;
  let presentation: ReturnType<typeof createUpdateProgress> | undefined;
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  beforeEach(() => {
    run = runRecord();
    vi.mocked(getUpdateRun).mockImplementation(() => run);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  });

  afterEach(() => {
    presentation?.dispose();
    presentation = undefined;
    if (tty) {
      Object.defineProperty(process.stdout, "isTTY", tty);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replays rapid recorded phases once and preserves redirected step failures", () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    run.phase = "validating";
    run.steps.push(
      { step: "staging", status: "completed" },
      { step: "validating", status: "in_progress" },
    );
    presentation.progress.onStepStart?.(step);
    expect(log).toHaveBeenCalledWith("validating — build...");
    presentation.progress.onStepComplete?.({
      ...step,
      durationMs: 1200,
      exitCode: 1,
      stdoutTail: "Build type error",
    });
    const lines = log.mock.calls.flat();
    expect(lines.filter((line) => typeof line === "string" && line.startsWith("Phase:"))).toEqual([
      "Phase: requested",
      "Phase: staging",
      "Phase: validating",
    ]);
    expect(lines.join("\n")).toContain("Build type error");
  });

  it("follows restart verification after step progress stops and flushes before the final report", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    presentation.stop();
    // The restarted gateway writes these phases while the CLI has no active step.
    run.phase = "verifying";
    run.steps.push(
      { step: "restarting", status: "completed" },
      { step: "verifying", status: "in_progress" },
    );
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Phase: verifying"));
    expect(log).toHaveBeenCalledWith("Phase: restarting");
    expect(log).not.toHaveBeenCalledWith("Phase: repairing");
    run.phase = "finished";
    run.status = "succeeded";
    run.after = { version: "2026.9.3" };
    run.verification = { serviceRunning: true, versionMatch: true };
    printResult(result, { run: context });
    presentation.dispose();
    const lines = log.mock.calls.flat();
    const finalPhase = lines.indexOf("Phase: finished");
    const report = lines.findIndex(
      (line) => typeof line === "string" && line.includes("OpenClaw updated to 2026.9.3"),
    );
    expect(finalPhase).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(finalPhase);
    expect(lines.filter((line) => line === "Phase: verifying")).toHaveLength(1);
    expect(lines.filter((line) => line === "Phase: finished")).toHaveLength(1);
    expect(lines.join("\n")).toContain("service running; version verified");
  });

  it("keeps JSON stdout silent until one result containing the durable row", () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    presentation = createUpdateProgress(false, context);
    presentation.suspend();
    presentation.resume();
    presentation.progress.onStepStart?.(step);
    presentation.progress.onStepComplete?.({ ...step, durationMs: 1, exitCode: 0 });
    presentation.stop();
    run.phase = "finished";
    run.status = "succeeded";
    printResult(result, { json: true, run: context });
    expect(log).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({ ...result, run });
  });

  it("suspends every ledger reader through activation and resumes the recorded timeline", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    presentation.suspend();
    const read = vi
      .mocked(getUpdateRun)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("candidate owns the migrated ledger");
      });
    presentation.progress.onStepStart?.(step);
    presentation.progress.onStepComplete?.({ ...step, durationMs: 10, exitCode: 0 });
    vi.advanceTimersByTime(500);
    expect(read).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("build...");

    run.phase = "verifying";
    run.steps.push(
      { step: "activating", status: "completed" },
      { step: "restarting", status: "completed" },
      { step: "verifying", status: "in_progress" },
    );
    read.mockImplementation(() => run);
    presentation.resume();
    vi.advanceTimersByTime(500);
    expect(read).toHaveBeenCalled();
    expect(
      log.mock.calls.flat().filter((line) => typeof line === "string" && line.startsWith("Phase:")),
    ).toEqual(["Phase: requested", "Phase: activating", "Phase: restarting", "Phase: verifying"]);

    presentation.suspend();
    read.mockClear().mockImplementation(() => {
      throw new Error("candidate owns the migrated ledger");
    });
    presentation.dispose();
    presentation.dispose();
    presentation.resume();
    vi.advanceTimersByTime(500);
    expect(read).not.toHaveBeenCalled();
  });
});
