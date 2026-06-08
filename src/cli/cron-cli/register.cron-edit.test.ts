// Cron edit register tests cover cron edit command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("cron edit command", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("documents that --best-effort-deliver implies announce mode when used alone (#83908)", () => {
    const editCommand = createCronProgram().commands.find((command) => command.name() === "edit");
    const help = editCommand?.helpInformation() ?? "";

    expect(help).toContain("--best-effort-deliver");
    expect(help).toMatch(/also\s+implies --announce when used alone/);
  });

  it("keeps --best-effort-deliver-only edits delivery-only (#83908)", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--best-effort-deliver"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ bestEffortDeliver: true }),
      {
        id: "job-1",
        patch: {
          delivery: {
            mode: "announce",
            bestEffort: true,
          },
        },
      },
    );
  });

  it("keeps --no-best-effort-deliver-only edits delivery-only", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--no-best-effort-deliver"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ bestEffortDeliver: false }),
      {
        id: "job-1",
        patch: {
          delivery: {
            bestEffort: false,
          },
        },
      },
    );
  });

  it("preserves command payload kind for timeout-only edits", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-1",
              payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
            },
          ],
        };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--timeout-seconds", "12"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ timeoutSeconds: "12" }),
      {
        id: "job-1",
        patch: {
          payload: {
            kind: "command",
            timeoutSeconds: 12,
          },
        },
      },
    );
  });
});
