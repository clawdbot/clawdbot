import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { runInteractiveUpdateFailureAction } from "./update-command-report.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn<() => Promise<string | symbol>>(),
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
  prepare:
    vi.fn<typeof import("../../infra/update-failure-report.js").prepareUpdateFailureReport>(),
  submit: vi.fn<typeof import("../../infra/update-failure-report.js").submitUpdateFailureReport>(),
}));

vi.mock("../../commands/configure.shared.js", () => ({
  select: mocks.select,
  confirm: mocks.confirm,
}));
vi.mock("../../infra/update-failure-report.js", () => ({
  prepareUpdateFailureReport: mocks.prepare,
  submitUpdateFailureReport: mocks.submit,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const failure: UpdateRunResult = {
  status: "error",
  mode: "npm",
  reason: "global-install-failed",
  before: { version: "2026.8.1" },
  steps: [],
  durationMs: 1,
  recovery: { serviceRestartSafe: true, version: "2026.8.1" },
};

function setup(
  action: "triage" | "report" | "dismiss" | Array<"triage" | "report" | "dismiss">,
  confirmed: boolean,
) {
  const stateDir = tempDirs.make("openclaw-update-report-cli-");
  const prepared = {
    attemptId: "attempt-cli",
    body: "sanitized preview",
    previewDigest: "a".repeat(64),
    marker: `openclaw-report:${"b".repeat(64)}`,
    browserFallback: {
      status: "available" as const,
      url: "https://github.com/openclaw/openclaw/issues/new",
    },
    savedReportPath: `${stateDir}/report.md`,
    title: "Update failure",
    url: "https://github.com/openclaw/openclaw/issues/new",
  };
  const prepare = mocks.prepare.mockReset().mockResolvedValue(prepared);
  const submit = mocks.submit.mockReset().mockResolvedValue({
    savedReportPath: prepared.savedReportPath,
    status: "created" as const,
    url: "https://github.com/openclaw/openclaw/issues/123",
  });
  const runtime = { log: vi.fn(), error: vi.fn() };
  const actions = Array.isArray(action) ? [...action] : [action];
  const chooseAction = mocks.select
    .mockReset()
    .mockImplementation(async () => actions.shift() ?? "dismiss");
  mocks.confirm.mockReset().mockResolvedValue(confirmed);
  const run = () =>
    runInteractiveUpdateFailureAction({
      attemptId: "attempt-cli",
      env: { OPENCLAW_STATE_DIR: stateDir },
      result: failure,
      runtime,
    });
  return { chooseAction, prepare, prepared, run, runtime, submit };
}

describe("interactive update failure action", () => {
  it("keeps diagnosis as a distinct action without preparing a report", async () => {
    const fixture = setup("triage", false);

    await expect(fixture.run()).resolves.toBe("triage");
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("shows the sanitized preview and honors cancellation without submission", async () => {
    const fixture = setup("report", false);

    await expect(fixture.run()).resolves.toBe("handled");
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.runtime.log).toHaveBeenCalledWith("sanitized preview");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(fixture.runtime.log).toHaveBeenCalledWith("Update failure report cancelled.");
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("submits the exact reviewed digest only after confirmation", async () => {
    const fixture = setup("report", true);

    await expect(fixture.run()).resolves.toBe("handled");
    expect(fixture.submit).toHaveBeenCalledWith(
      fixture.prepared,
      fixture.prepared.previewDigest,
      expect.any(Object),
    );
    expect(fixture.runtime.log).toHaveBeenCalledWith(
      "Created GitHub issue: https://github.com/openclaw/openclaw/issues/123",
    );
  });

  it("returns a retryable no-start result to explicit action and confirmation", async () => {
    const fixture = setup(["report", "report"], true);
    fixture.submit
      .mockReset()
      .mockResolvedValueOnce({
        message: "spawn gh EAGAIN",
        savedReportPath: fixture.prepared.savedReportPath,
        status: "retryable",
      })
      .mockResolvedValueOnce({
        savedReportPath: fixture.prepared.savedReportPath,
        status: "created",
        url: "https://github.com/openclaw/openclaw/issues/123",
      });

    await expect(fixture.run()).resolves.toBe("handled");
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.submit).toHaveBeenCalledTimes(2);
    expect(fixture.chooseAction).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.log).toHaveBeenCalledWith("spawn gh EAGAIN");
    expect(fixture.runtime.log).toHaveBeenCalledWith(
      "Created GitHub issue: https://github.com/openclaw/openclaw/issues/123",
    );
  });

  it("does nothing when the action menu is dismissed", async () => {
    const fixture = setup("dismiss", true);

    await expect(fixture.run()).resolves.toBe("handled");
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it.each(["prepare", "submit"] as const)(
    "returns a failed %s attempt to the explicit action surface",
    async (phase) => {
      const fixture = setup(["report", "dismiss"], true);
      if (phase === "prepare") {
        fixture.prepare.mockRejectedValueOnce(new Error("report storage unavailable"));
      } else {
        fixture.submit.mockRejectedValueOnce(new Error("report transport unavailable"));
      }

      await expect(fixture.run()).resolves.toBe("handled");

      expect(fixture.chooseAction).toHaveBeenCalledTimes(2);
      expect(fixture.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `report ${phase === "prepare" ? "storage" : "transport"} unavailable`,
        ),
      );
    },
  );

  it("requires a fresh explicit choice before diagnosing after a report failure", async () => {
    const fixture = setup(["report", "triage"], true);
    fixture.submit.mockRejectedValueOnce(new Error("report unavailable"));

    await expect(fixture.run()).resolves.toBe("triage");

    expect(fixture.chooseAction).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("report unavailable"),
    );
  });
});
