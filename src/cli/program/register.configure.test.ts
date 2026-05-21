import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigureCommand } from "./register.configure.js";

const mocks = vi.hoisted(() => ({
  configureCommandFromSectionsArgMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const { configureCommandFromSectionsArgMock, runtime } = mocks;

vi.mock("../../commands/configure.shared.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: ["auth", "channels", "gateway", "agent"],
}));

vi.mock("../../commands/configure.commands.js", () => ({
  configureCommandFromSectionsArg: mocks.configureCommandFromSectionsArgMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerConfigureCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerConfigureCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    configureCommandFromSectionsArgMock.mockResolvedValue(undefined);
  });

  it("forwards repeated --section values", async () => {
    await runCli(["configure", "--section", "auth", "--section", "channels"]);

    expect(configureCommandFromSectionsArgMock).toHaveBeenCalledWith(["auth", "channels"], runtime);
  });

  it("reports errors through runtime when configure command fails", async () => {
    configureCommandFromSectionsArgMock.mockRejectedValueOnce(new Error("configure failed"));

    await runCli(["configure"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: configure failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
