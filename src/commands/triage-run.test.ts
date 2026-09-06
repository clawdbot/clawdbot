import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  runUpdateRepairLoop: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  resolveGatewayInstallEntrypoint: vi.fn(),
}));
vi.mock("./doctor-lint.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../infra/update-repair-agent.js", () => ({
  runUpdateRepairLoop: mocks.runUpdateRepairLoop,
}));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: () => undefined,
}));
vi.mock("../process/exec.js", () => ({
  runUtf8CommandWithTimeout: mocks.runUtf8CommandWithTimeout,
}));
vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveGatewayInstallEntrypoint,
}));

describe("triage --run", () => {
  let stateDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = tempDirs.make("openclaw-triage-run-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", undefined);
    mocks.collectDoctorFindings.mockResolvedValue([]);
    mocks.resolveGatewayInstallEntrypoint.mockImplementation(async (root) =>
      path.join(root, "dist/index.js"),
    );
    mocks.runUtf8CommandWithTimeout.mockResolvedValue({
      code: 0,
      termination: "exit",
      stdout: JSON.stringify({ ok: true, findings: [] }),
    });
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "repaired",
      attempts: [],
      finalValidation: { ok: true, score: 0, summary: "Doctor lint reports no errors." },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the onboarding hint when embedded repair has no usable inference", async () => {
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "unavailable",
      attempts: [],
      finalValidation: { ok: false, score: -1, summary: "Doctor lint found an error." },
      reason: "The configured model is unavailable",
    });
    const runtime = createTriageRuntime();

    await withTriageTerminal(true, async () => {
      await expect(triageCommand(runtime, { noExport: true, run: true })).rejects.toThrow(
        "Run `openclaw onboard` or use a suggested handoff command.",
      );
    });
    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledOnce();
  });

  it("runs one shared repair turn with fresh Doctor severity validation and the captured target", async () => {
    const runtime = createTriageRuntime();
    const signal = new AbortController().signal;
    // A captured cwd can be another checkout; repair must stay with the running CLI's package.
    await fs.writeFile(path.join(stateDir, "package.json"), JSON.stringify({ name: "openclaw" }));
    mocks.runUtf8CommandWithTimeout
      .mockResolvedValueOnce({
        code: 1,
        termination: "exit",
        stdout: JSON.stringify({
          ok: false,
          findings: [{ severity: "error", message: "Broken installation" }],
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        termination: "exit",
        stdout: JSON.stringify({
          ok: true,
          findings: [{ severity: "warning", message: "Optional improvement" }],
        }),
      });
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      expect(await validate(signal)).toEqual({
        ok: false,
        score: -1,
        summary: "1 Doctor lint error(s): Broken installation",
      });
      const finalValidation = await validate(signal);
      expect(finalValidation).toEqual({
        ok: true,
        score: 0,
        summary: "Doctor lint reports no errors.",
      });
      return { status: "repaired", attempts: [], finalValidation };
    });

    await withTriageTerminal(true, () =>
      triageCommand(runtime, {
        noExport: true,
        run: true,
        recovery: {
          target: resolveInstallationTarget(),
          cwd: stateDir,
          updateFailure: { error: "Captured update failure" },
        },
      }),
    );

    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: {
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          workspaceDir: path.join(stateDir, "workspace"),
          installRoot: path.resolve(import.meta.dirname, "../.."),
        },
        context: expect.objectContaining({ error: "Captured update failure", phase: "verifying" }),
        budget: { maxTurns: 1 },
      }),
    );
    expect(mocks.collectDoctorFindings).not.toHaveBeenCalled();
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledWith(
      [
        process.execPath,
        path.resolve(import.meta.dirname, "../../dist/index.js"),
        "doctor",
        "--lint",
        "--json",
        "--severity-min",
        "error",
      ],
      expect.objectContaining({
        cwd: path.resolve(import.meta.dirname, "../.."),
        baseEnv: {},
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
        }),
        signal,
        input: "",
        killProcessTree: true,
        terminateOnOutputLimit: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Embedded repair repaired: Doctor lint reports no errors.",
    );
  });

  it("explains policy-denied repair and points to the external handoff", async () => {
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "unavailable",
      reason: "exec-denied-by-policy",
      attempts: [],
      finalValidation: { ok: false, score: -1, summary: "Broken installation" },
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toThrow(
      "The operator's policy denies unattended repair (exec-denied-by-policy). Use `openclaw triage` for an external handoff.",
    );
  });

  it("reports Doctor collection failures to the repair oracle with secrets redacted", async () => {
    const secret = "sk-test-triage-oracle-secret-1234567890";
    mocks.runUtf8CommandWithTimeout.mockRejectedValue(
      new Error(`Doctor unavailable; token=${secret}`),
    );
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      const finalValidation = await validate(new AbortController().signal);
      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.score).toBe(Number.MIN_SAFE_INTEGER);
      expect(finalValidation.summary).toContain("Doctor checks unavailable:");
      expect(finalValidation.summary).not.toContain(secret);
      return { status: "unrepaired", attempts: [], finalValidation };
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it.each([
    { name: "malformed JSON", result: { code: 0, termination: "exit", stdout: "not-json" } },
    { name: "missing findings", result: { code: 0, termination: "exit", stdout: "{}" } },
    {
      name: "unexplained failure",
      result: { code: 1, termination: "exit", stdout: '{"ok":false,"findings":[]}' },
    },
    {
      name: "output limit",
      result: { code: null, termination: "signal", stdout: "", outputLimitExceeded: true },
    },
  ])("never accepts $name as healthy Doctor validation", async ({ result }) => {
    mocks.runUtf8CommandWithTimeout.mockResolvedValue(result);
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      const finalValidation = await validate(new AbortController().signal);
      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.summary).toContain("Doctor checks unavailable:");
      return { status: "unrepaired", attempts: [], finalValidation };
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("propagates validation cancellation after the Doctor child settles", async () => {
    const controller = new AbortController();
    const reason = new Error("wall-clock-budget");
    mocks.runUtf8CommandWithTimeout.mockImplementation(async (_argv, { signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      return { termination: "signal", code: null, stdout: "" };
    });
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      await expect(validate(controller.signal)).rejects.toBe(reason);
      return {
        status: "aborted",
        reason: "wall-clock-budget",
        attempts: [],
        finalValidation: { ok: false, score: -1, summary: "Cancelled" },
      };
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toMatchObject({ code: 2 });
  });

  it.each([
    { interactive: false, nonInteractive: false },
    { interactive: true, nonInteractive: true },
  ])(
    "refuses embedded execution without an allowed terminal ($interactive/$nonInteractive)",
    async ({ interactive, nonInteractive }) => {
      await expect(
        withTriageTerminal(interactive, () =>
          triageCommand(createTriageRuntime(), { noExport: true, run: true, nonInteractive }),
        ),
      ).rejects.toThrow("Embedded triage requires an interactive terminal");
      expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "improved", reason: "turn-budget", code: 1 },
    { status: "unrepaired", reason: "Validation regressed after repair.", code: 1 },
    { status: "aborted", reason: "cancelled", code: 1 },
    { status: "unrepaired", reason: "per-turn-budget", code: 2 },
    { status: "improved", reason: "wall-clock-budget", code: 2 },
  ])(
    "reports $status and preserves nonzero exit $code for $reason",
    async ({ status, reason, code }) => {
      mocks.runUpdateRepairLoop.mockResolvedValue({
        status,
        reason,
        attempts: [{ summary: "Attempt completed." }],
        finalValidation: { ok: false, score: -1, summary: "Doctor lint found an error." },
      });
      const runtime = createTriageRuntime();
      await expect(
        withTriageTerminal(true, () => triageCommand(runtime, { noExport: true, run: true })),
      ).rejects.toMatchObject({ code });
      expect(runtime.log).toHaveBeenCalledWith("Attempt completed.");
      expect(runtime.log).toHaveBeenCalledWith(
        `Embedded repair ${status}: Doctor lint found an error.`,
      );
      expect(runtime.error).toHaveBeenCalledWith(reason);
    },
  );

  it("runs embedded triage from in-memory diagnostics when its artifact cannot be saved", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("EACCES: support artifact permission denied"), { code: "EACCES" }),
    );
    const runtime = createTriageRuntime();

    await withTriageTerminal(true, () => triageCommand(runtime, { noExport: true, run: true }));

    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        context: expect.objectContaining({ error: "Operator requested installation triage" }),
      }),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/^Debugging prompt: /u));
  });

  it("does not publish a result after its recovery owner closes during repair", async () => {
    let current = true;
    const runtime = createTriageRuntime();
    mocks.runUpdateRepairLoop.mockImplementation(async ({ isCurrent, onEvent }) => {
      expect(isCurrent()).toBe(true);
      onEvent({ type: "turn-started", turn: 1, provider: "openai", model: "gpt-5.6-luna" });
      expect(runtime.log).toHaveBeenCalledWith("Starting repair turn 1 with openai/gpt-5.6-luna.");
      current = false;
      return {
        status: "aborted",
        attempts: [],
        finalValidation: { ok: false, score: -1, summary: "Closed" },
      };
    });
    await withTriageTerminal(true, () =>
      triageCommand(runtime, {
        run: true,
        noExport: true,
        recovery: {
          target: resolveInstallationTarget(),
          updateFailure: { error: "Captured update failure" },
          isCurrent: () => current,
        },
      }),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Embedded repair aborted"),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
