// Cron edit register tests cover cron edit command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronEditCommand } = await import("./register.cron-edit.js");

function createCronProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronEditCommand(program);
  return program;
}

async function expectCronEditRejection(args: string[], message: string): Promise<void> {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);

  try {
    await createCronProgram().parseAsync(["edit", "job-1", ...args], { from: "user" });

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe("cli cron edit precheck flags", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("rejects orphaned --precheck-timeout-ms without existing gate or --precheck-command", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return { id: "job-1", name: "n" };
      }
      return { ok: true };
    });
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);
    try {
      await createCronProgram().parseAsync(["edit", "job-1", "--precheck-timeout-ms", "5000"], {
        from: "user",
      });
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          "--precheck-timeout-ms/--precheck-cwd require an existing precheck gate or --precheck-command",
        ),
      );
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
        id: "job-1",
      });
      expect(callGatewayFromCli).not.toHaveBeenCalledWith(
        "cron.update",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("merges --precheck-timeout-ms onto an existing precheck gate", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          name: "n",
          precheck: { kind: "exec", command: "test -f /tmp/flag", timeoutMs: 1000 },
        };
      }
      return { ok: true };
    });
    await createCronProgram().parseAsync(
      ["edit", "job-1", "--precheck-timeout-ms", "5000", "--json"],
      { from: "user" },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        precheck: { kind: "exec", command: "test -f /tmp/flag", timeoutMs: 5000 },
      },
    });
  });

  it("preserves custom contract/exit codes/prefixes/onError on ancillary timeout edit", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          name: "n",
          precheck: {
            kind: "exec",
            command: "probe.sh",
            timeoutMs: 1000,
            cwd: "/tmp/work",
            contract: "exit-code",
            workExitCodes: [0],
            noWorkExitCodes: [2],
            workStdoutPrefix: "WORK:",
            noWorkStdoutPrefix: "IDLE:",
            onError: "skip",
          },
        };
      }
      return { ok: true };
    });
    await createCronProgram().parseAsync(
      ["edit", "job-1", "--precheck-timeout-ms", "9000", "--json"],
      { from: "user" },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        precheck: {
          kind: "exec",
          command: "probe.sh",
          timeoutMs: 9000,
          cwd: "/tmp/work",
          contract: "exit-code",
          workExitCodes: [0],
          noWorkExitCodes: [2],
          workStdoutPrefix: "WORK:",
          noWorkStdoutPrefix: "IDLE:",
          onError: "skip",
        },
      },
    });
  });

  it("rejects invalid --precheck-timeout-ms on edit", async () => {
    await expectCronEditRejection(
      ["--precheck-command", "true", "--precheck-timeout-ms", "0"],
      "Invalid --precheck-timeout-ms (must be a positive integer).",
    );
  });
});
