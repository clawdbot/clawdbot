// Interactive onboarding tests cover wizard cancellation, setup routing, and runtime output.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import {
  acknowledgeInteractiveOnboardingRisk,
  runInteractiveSetup,
} from "./onboard-interactive.js";

const mocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(() => ({ id: "prompter" })),
  runSetupWizard: vi.fn(async () => {}),
  requireRiskAcknowledgement: vi.fn(async () => ({})),
  restoreTerminalState: vi.fn(),
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../wizard/setup.js", () => ({
  runSetupWizard: mocks.runSetupWizard,
}));

vi.mock("../wizard/setup.shared.js", () => ({
  requireRiskAcknowledgement: mocks.requireRiskAcknowledgement,
}));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: mocks.restoreTerminalState,
}));

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

describe("runInteractiveSetup", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("restores terminal state without resuming stdin on success", async () => {
    const runtime = makeRuntime();

    await runInteractiveSetup({} as never, runtime);

    expect(mocks.runSetupWizard).toHaveBeenCalledOnce();
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
  });

  it("restores terminal state without resuming stdin on cancel", async () => {
    const exitError = new Error("exit");
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw exitError;
      }) as unknown as RuntimeEnv["exit"],
    };
    mocks.runSetupWizard.mockRejectedValueOnce(new WizardCancelledError("cancelled"));

    await expect(runInteractiveSetup({} as never, runtime)).rejects.toBe(exitError);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
    const restoreOrder =
      mocks.restoreTerminalState.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const exitOrder =
      (runtime.exit as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
      Number.MAX_SAFE_INTEGER;
    expect(restoreOrder).toBeLessThan(exitOrder);
  });

  it("rethrows non-cancel errors after restoring terminal state", async () => {
    const runtime = makeRuntime();
    const err = new Error("boom");
    mocks.runSetupWizard.mockRejectedValueOnce(err);

    await expect(runInteractiveSetup({} as never, runtime)).rejects.toThrow("boom");

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
  });
});

describe("acknowledgeInteractiveOnboardingRisk", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("completes one acknowledgement with the existing config", async () => {
    const runtime = makeRuntime();
    const config = { gateway: { port: 19_001 } };

    await expect(
      acknowledgeInteractiveOnboardingRisk({ reset: true }, config, runtime),
    ).resolves.toBe(true);

    expect(mocks.requireRiskAcknowledgement).toHaveBeenCalledOnce();
    expect(mocks.requireRiskAcknowledgement).toHaveBeenCalledWith({
      opts: { reset: true },
      prompter: { id: "prompter" },
      config,
    });
  });

  it.each(["Ctrl-C", "EOF"])("maps %s cancellation before reset to exit 1", async () => {
    const runtime = makeRuntime();
    mocks.requireRiskAcknowledgement.mockRejectedValueOnce(
      new WizardCancelledError("risk not accepted"),
    );

    await expect(acknowledgeInteractiveOnboardingRisk({ reset: true }, {}, runtime)).resolves.toBe(
      false,
    );

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
  });
});
