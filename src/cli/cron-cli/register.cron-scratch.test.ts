// Cron scratch register tests cover cron scratch command option validation.
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

const { registerCronScratchCommand } = await import("./register.cron-scratch.js");

function createCronProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronScratchCommand(program);
  return program;
}

describe("cron scratch command", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.scratch.get") {
        return {
          scratch: { content: "note", revision: 2, updatedAtMs: 1 },
          currentRevision: 2,
          maxBytes: 1024,
        };
      }
      return { ok: true, scratch: null, currentRevision: 3, maxBytes: 1024 };
    });
  });

  it.each(["0x2", "1e2", "2.5", "-1", "2a"])(
    "rejects non-decimal --expected-revision %j",
    async (revision) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(defaultRuntime, "exit")
        .mockImplementation((() => undefined) as never);

      try {
        await createCronProgram().parseAsync(
          ["scratch", "job-1", "--set", "x", "--expected-revision", revision],
          { from: "user" },
        );

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--expected-revision must be a non-negative integer"),
        );
        const setCalls = callGatewayFromCli.mock.calls.filter(
          ([method]) => method === "cron.scratch.set",
        );
        expect(setCalls).toHaveLength(0);
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
    },
  );

  it.each([
    ["0", 0],
    ["42", 42],
  ])(
    "passes decimal --expected-revision %j through to the CAS write",
    async (revision, expectedRevision) => {
      await createCronProgram().parseAsync(
        ["scratch", "job-1", "--set", "x", "--expected-revision", revision],
        { from: "user" },
      );

      const setCall = callGatewayFromCli.mock.calls.find(
        ([method]) => method === "cron.scratch.set",
      );
      expect(setCall?.[2]).toMatchObject({ expectedRevision });
    },
  );
});
