import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { configureCommandFromSectionsArg } from "./configure.commands.js";

// Hoisted mock so the wizard never actually runs; the tests assert whether the
// fail-closed guard reached the wizard at all.
const runConfigureWizardMock = vi.hoisted(() => vi.fn());

vi.mock("./configure.wizard.js", () => ({
  runConfigureWizard: runConfigureWizardMock,
}));

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    // `exit` throws so an assertion failure surfaces in-test instead of killing
    // the process; we assert it is called with code 1.
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
  };
}

describe("configureCommandFromSectionsArg", () => {
  beforeEach(() => {
    runConfigureWizardMock.mockReset();
    runConfigureWizardMock.mockResolvedValue(undefined);
  });

  it("fails closed on a non-interactive terminal before reaching the wizard (#93953)", async () => {
    const runtime = makeRuntime();

    // `interactive: false` stands in for a piped stdin/stdout without mutating
    // the global `process` streams.
    await expect(
      configureCommandFromSectionsArg(undefined, runtime, { interactive: false }),
    ).rejects.toThrow("exit 1");

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    // The hint must point at real subcommands, not the wizard itself.
    const message = runtime.error.mock.calls[0]?.[0] as string;
    expect(message).toContain("requires an interactive terminal (TTY)");
    expect(message).toContain(formatCliCommand("openclaw config set"));
    expect(message).toContain(formatCliCommand("openclaw config validate"));
    // The wizard must never start on a non-TTY.
    expect(runConfigureWizardMock).not.toHaveBeenCalled();
  });

  it("fails closed for an explicit --section list on a non-interactive terminal", async () => {
    const runtime = makeRuntime();

    await expect(
      configureCommandFromSectionsArg(["channels"], runtime, { interactive: false }),
    ).rejects.toThrow("exit 1");

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runConfigureWizardMock).not.toHaveBeenCalled();
  });

  it("runs the wizard on an interactive terminal with no sections", async () => {
    const runtime = makeRuntime();

    await configureCommandFromSectionsArg(undefined, runtime, { interactive: true });

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runConfigureWizardMock).toHaveBeenCalledTimes(1);
    expect(runConfigureWizardMock).toHaveBeenCalledWith({ command: "configure" }, runtime);
  });

  it("runs the wizard with sections on an interactive terminal", async () => {
    const runtime = makeRuntime();

    await configureCommandFromSectionsArg(["channels", "plugins"], runtime, {
      interactive: true,
    });

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runConfigureWizardMock).toHaveBeenCalledWith(
      { command: "configure", sections: ["channels", "plugins"] },
      runtime,
    );
  });

  it("rejects a lone invalid section before unrestricted wizard dispatch", async () => {
    const runtime = makeRuntime();

    await expect(
      configureCommandFromSectionsArg(["bogus"], runtime, { interactive: true }),
    ).rejects.toThrow("exit 1");

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error.mock.calls[0]?.[0]).toBe(
      "Invalid --section: bogus. Expected one of: workspace, model, web, gateway, daemon, channels, plugins, skills, health. Run openclaw configure without --section to use the full wizard.",
    );
    expect(runConfigureWizardMock).not.toHaveBeenCalled();
  });

  it("validates invalid sections before the interactive-terminal guard", async () => {
    const runtime = makeRuntime();

    await expect(
      configureCommandFromSectionsArg(["channels", "bogus"], runtime, {
        interactive: false,
      }),
    ).rejects.toThrow("exit 1");

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("Invalid --section: bogus");
    expect(runConfigureWizardMock).not.toHaveBeenCalled();
  });
});
