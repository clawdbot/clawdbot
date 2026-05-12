import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { onboardCommand, setupWizardCommand } from "./onboard.js";

const mocks = vi.hoisted(() => ({
  runInteractiveSetup: vi.fn(async () => {}),
  runNonInteractiveSetup: vi.fn(async () => {}),
  readConfigFileSnapshot: vi.fn(async () => ({ exists: false, valid: false, config: {} })),
  handleReset: vi.fn(async () => {}),
}));

vi.mock("./onboard-interactive.js", () => ({
  runInteractiveSetup: mocks.runInteractiveSetup,
}));

vi.mock("./onboard-non-interactive.js", () => ({
  runNonInteractiveSetup: mocks.runNonInteractiveSetup,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  handleReset: mocks.handleReset,
}));

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

function expectResetCall(params: { scope: string; runtime: RuntimeEnv; workspace?: string }): void {
  const calls = mocks.handleReset.mock.calls as unknown as Array<[string, string, RuntimeEnv]>;
  const call = calls[0];
  if (!call) {
    throw new Error("expected handleReset call");
  }
  expect(call[0]).toBe(params.scope);
  if (params.workspace) {
    expect(call[1]).toBe(params.workspace);
  } else {
    expect(typeof call[1]).toBe("string");
  }
  expect(call[2]).toBe(params.runtime);
}

describe("setupWizardCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({ exists: false, valid: false, config: {} });
  });

  it("fails fast for invalid secret-input-mode before setup starts", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        secretInputMode: "invalid" as never, // pragma: allowlist secret
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for the interactive setup.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("logs ASCII-safe Windows guidance before setup", async () => {
    const runtime = makeRuntime();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await setupWizardCommand({}, runtime);

      expect(runtime.log).toHaveBeenCalledWith(
        [
          "Windows detected - OpenClaw runs great on WSL2!",
          "Native Windows might be trickier.",
          "Quick setup: wsl --install (one command, one reboot)",
          "Guide: https://docs.openclaw.ai/windows",
        ].join("\n"),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("defaults --reset to config+creds+sessions scope", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
      },
      runtime,
    );

    expectResetCall({ scope: "config+creds+sessions", runtime });
  });

  it("uses configured default workspace for --reset when --workspace is not provided", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/openclaw-custom-workspace",
          },
        },
      },
    });

    await setupWizardCommand(
      {
        reset: true,
      },
      runtime,
    );

    expect(mocks.handleReset).toHaveBeenCalledWith(
      "config+creds+sessions",
      path.resolve("/tmp/openclaw-custom-workspace"),
      runtime,
    );
  });

  it("accepts explicit --reset-scope full", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        resetScope: "full",
      },
      runtime,
    );

    expectResetCall({ scope: "full", runtime });
  });

  it("fails fast for invalid --reset-scope", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        resetScope: "invalid" as never,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --reset-scope. Use "config", "config+creds+sessions", or "full". Run ${formatCliCommand("openclaw onboard --reset --reset-scope config")} for a config-only reset.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("keeps onboardCommand as an alias for setupWizardCommand", () => {
    expect(onboardCommand).toBe(setupWizardCommand);
  });
});
