// Non-ok finishUpdate recovery: skipped exit status and failed-update
// restart provenance. Split from the success-path suite so both stay
// under the src test max-lines budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  printResult: vi.fn(),
  restart: vi.fn(async () => undefined),
  restoreWindowsAutoStart: vi.fn(async () => true),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  restoreWindowsTaskAutoStartOrExit: mocks.restoreWindowsAutoStart,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { finishUpdate } from "./update-command-post-update.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

afterEach(() => {
  vi.unstubAllEnvs();
});

function failedResult(recovery: UpdateRunResult["recovery"]): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    root: "/repo",
    recovery,
    steps: [],
    durationMs: 1,
  };
}

async function finishFailedUpdate(
  result: UpdateRunResult,
  options: { json?: boolean; stopped?: boolean } = {},
): Promise<void> {
  await finishUpdate({
    result,
    opts: { json: options.json },
    showProgress: false,
    startedAt: Date.now(),
    preManagedServiceStop: { stopped: options.stopped ?? true, serviceEnv: {} },
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

async function finishSkippedUpdate(reason: string): Promise<void> {
  await finishUpdate({
    result: {
      status: "skipped",
      mode: reason === "dirty" ? "git" : "unknown",
      reason,
      steps: [],
      durationMs: 1,
    },
    opts: {},
    showProgress: false,
    startedAt: Date.now(),
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

describe("skipped update exit status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  it.each([
    ["dirty", 1],
    ["not-git-install", 0],
  ] as const)("handles %s with exit %i", async (reason, exitCode) => {
    await finishSkippedUpdate(reason);
    if (reason === "dirty") {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Update blocked: local files are edited"),
      );
    }
    expect(defaultRuntime.exit).toHaveBeenCalledWith(exitCode);
  });
});

describe("failed Git update recovery restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it.each(["error", "skipped"] as const)(
    "records the %s outcome before recovery starts the Gateway",
    async (status) => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mocks.restart.mockImplementationOnce(async () => {
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toMatchObject({ status });
        expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
        expect(mocks.printResult).not.toHaveBeenCalled();
        now += 200;
      });

      await finishFailedUpdate({ ...failedResult({ serviceRestartSafe: true }), status });

      expect(mocks.restart).toHaveBeenCalledWith(
        expect.objectContaining({ root: "/repo", packageReplacementVerified: false }),
      );
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status, durationMs: 200 });
    },
  );

  it("leaves a managed Gateway stopped after unverified rollback recovery", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
    );

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("repair the checkout or installation"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rerun `openclaw update`"));
  });

  it("explains how to recover from a dirty rollback checkout", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(output).toContain("From the update root shown above");
    expect(output).toContain("git status --short");
    expect(output).toContain("resolve the reported changes");
    expect(output).toContain("rerun `openclaw update`");
    expect(output).toContain("Keep the gateway stopped until the update succeeds");
  });

  it("preserves the active profile in unsafe recovery guidance", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("rerun `openclaw --profile work update`");
    expect(output).not.toContain("rerun `openclaw update`");
  });

  it("does not claim an unsafe recovery stopped a service that was already down", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
      { stopped: false },
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Update recovery could not prove a runnable installation");
    expect(output).toContain("resolve the reported changes");
    expect(output).not.toContain("remains stopped");
    expect(output).not.toContain("Keep the gateway stopped");
  });

  it("keeps structured JSON recovery free of prose guidance", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const result = failedResult({
      serviceRestartSafe: false,
      reason: "rollback-checkout-dirty",
    });

    await finishFailedUpdate(result, { json: true });

    expect(mocks.printResult).toHaveBeenCalledWith(
      expect.objectContaining({ ...result, durationMs: expect.any(Number) }),
      expect.objectContaining({ json: true }),
    );
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not claim a verified package replacement on Git failures", async () => {
    await finishFailedUpdate(failedResult({ serviceRestartSafe: true }));

    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({ packageReplacementVerified: false }),
    );
  });
});

describe("failed package update recovery provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it("threads a verified package replacement into failed-update recovery", async () => {
    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "global-install-failed",
        steps: [{ name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 }],
        packageReplacementVerified: true,
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({ packageReplacementVerified: true }),
    );
  });

  it("does not start a verification-rejected in-place candidate after replacement", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "global-install-failed",
        steps: [
          { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
          {
            name: "global install verify",
            command: "verify",
            cwd: "/",
            durationMs: 1,
            exitCode: 1,
          },
        ],
        packageReplacementVerified: true,
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });

  it("does not start an incomplete pnpm lifecycle candidate after replacement", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishUpdate({
      result: {
        status: "error",
        mode: "pnpm",
        reason: "global-install-failed",
        steps: [
          { name: "global update", command: "pnpm", cwd: "/", durationMs: 1, exitCode: 0 },
          {
            name: "pnpm package postinstall",
            command: "postinstall",
            cwd: "/",
            durationMs: 1,
            exitCode: 1,
          },
        ],
        packageReplacementVerified: true,
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });

  it("does not start a Doctor-rejected candidate even after a verified swap", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "doctor-failed",
        steps: [
          { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
          { name: "openclaw doctor", command: "doctor", cwd: "/", durationMs: 1, exitCode: 1 },
        ],
        packageReplacementVerified: true,
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });

  it("keeps pre-swap package failures on the guarded restart only", async () => {
    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "global-install-failed",
        steps: [{ name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 1 }],
        packageReplacementVerified: false,
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({ packageReplacementVerified: false }),
    );
  });
});
