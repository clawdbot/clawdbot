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

  it("updates one pacing bound while preserving the other", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return { id: "job-1", pacing: { min: "15m", max: "4h" } };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--pacing-min", "30m"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { pacing: { min: "30m", max: "4h" } },
    });
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

  it("does not set delivery mode to announce when disabling best-effort on payload edits", async () => {
    const program = createCronProgram();

    await program.parseAsync(
      ["edit", "job-1", "--no-best-effort-deliver", "--message", "new message"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        payload: {
          kind: "agentTurn",
          message: "new message",
        },
        delivery: {
          bestEffort: false,
        },
      },
    });
  });

  it("preserves timezone without copying stale stagger when --cron replaces expression (#92291)", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          schedule: {
            kind: "cron",
            expr: "0 * * * *",
            tz: "America/Phoenix",
            staggerMs: 120_000,
          },
        };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--cron", "0 5 * * *"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), { id: "job-1" });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        schedule: {
          kind: "cron",
          expr: "0 5 * * *",
          tz: "America/Phoenix",
          staggerMs: undefined,
        },
      },
    });
  });

  it("allows --tz override when --cron replaces expression (#92291)", async () => {
    const program = createCronProgram();

    await program.parseAsync(
      ["edit", "job-1", "--cron", "0 5 * * *", "--tz", "UTC", "--stagger", "10s"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        schedule: {
          kind: "cron",
          expr: "0 5 * * *",
          tz: "UTC",
          staggerMs: 10000,
        },
      },
    });
    expect(callGatewayFromCli).not.toHaveBeenCalledWith("cron.list", expect.anything(), {
      includeDisabled: true,
      limit: expect.any(Number),
      offset: expect.any(Number),
    });
  });

  it("preserves timezone when --cron edits stagger metadata (#92291)", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          schedule: {
            kind: "cron",
            expr: "0 * * * *",
            tz: "America/Phoenix",
            staggerMs: 120_000,
          },
        };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--cron", "0 5 * * *", "--stagger", "10s"], {
      from: "user",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        schedule: {
          kind: "cron",
          expr: "0 5 * * *",
          tz: "America/Phoenix",
          staggerMs: 10000,
        },
      },
    });
  });

  it("preserves command payload kind for timeout-only edits", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
        };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--timeout-seconds", "12"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
      id: "job-1",
    });
    expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.list")).toBe(false);
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

  it("falls back to cron.list when an older Gateway does not support cron.get", async () => {
    const unknownMethodError = Object.assign(new Error("unknown method: cron.get"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.get") {
          throw unknownMethodError;
        }
        if (method === "cron.list") {
          const offset = (params as { offset?: number }).offset ?? 0;
          if (offset === 0) {
            return {
              jobs: [{ id: "other-job", schedule: { kind: "cron", expr: "0 * * * *" } }],
              hasMore: true,
              nextOffset: 200,
            };
          }
          return {
            jobs: [
              {
                id: "job-1",
                schedule: { kind: "cron", expr: "0 */2 * * *", staggerMs: 300_000 },
              },
            ],
            hasMore: false,
            nextOffset: null,
          };
        }
        return { ok: true, params };
      },
    );
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--exact"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
      id: "job-1",
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.list", expect.anything(), {
      includeDisabled: true,
      limit: 200,
      offset: 0,
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.list", expect.anything(), {
      includeDisabled: true,
      limit: 200,
      offset: 200,
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        schedule: {
          kind: "cron",
          expr: "0 */2 * * *",
          staggerMs: 0,
        },
      },
    });
  });

  it("clears the model override with --clear-model (CLI parity with cron.update model:null)", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-model"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearModel: true }),
      {
        id: "job-1",
        patch: {
          payload: {
            kind: "agentTurn",
            model: null,
          },
        },
      },
    );
  });

  it("clears the thinking override with --clear-thinking (CLI parity with cron.update thinking:null)", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-thinking"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearThinking: true }),
      {
        id: "job-1",
        patch: {
          payload: {
            kind: "agentTurn",
            thinking: null,
          },
        },
      },
    );
  });

  it("rejects combining --thinking with --clear-thinking", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--thinking", "high", "--clear-thinking"], {
      from: "user",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Use --thinking or --clear-thinking, not both"),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("documents the --clear-model flag alongside the sibling --clear-tools", () => {
    const editCommand = createCronProgram().commands.find((command) => command.name() === "edit");
    const help = editCommand?.helpInformation() ?? "";

    expect(help).toContain("--clear-model");
    expect(help).toContain("--clear-thinking");
    expect(help).toContain("--clear-tools");
  });

  it("clears the delivery channel with --clear-channel (CLI parity with cron.update channel:null)", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-channel"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearChannel: true }),
      {
        id: "job-1",
        patch: { delivery: { channel: null } },
      },
    );
  });

  it("clears the delivery destination with --clear-to", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-to"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearTo: true }),
      {
        id: "job-1",
        patch: { delivery: { to: null } },
      },
    );
  });

  it("clears the delivery thread id with --clear-thread-id", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-thread-id"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearThreadId: true }),
      {
        id: "job-1",
        patch: { delivery: { threadId: null } },
      },
    );
  });

  it("clears the delivery account override with --clear-account", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-account"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearAccount: true }),
      {
        id: "job-1",
        patch: { delivery: { accountId: null } },
      },
    );
  });

  it.each([
    { set: "--channel", value: "telegram", clear: "--clear-channel" },
    { set: "--to", value: "12345", clear: "--clear-to" },
    { set: "--thread-id", value: "42", clear: "--clear-thread-id" },
    { set: "--account", value: "writer", clear: "--clear-account" },
  ])("rejects $set combined with $clear", async ({ set, value, clear }) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", set, value, clear], { from: "user" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Use ${set} or ${clear}, not both`),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("rejects --webhook combined with a delivery clear flag", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);
    const program = createCronProgram();

    await program.parseAsync(
      ["edit", "job-1", "--webhook", "https://example.invalid/hook", "--clear-channel"],
      { from: "user" },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--webhook cannot be combined with chat delivery options."),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("documents the delivery clear flags alongside the sibling --clear-model", () => {
    const editCommand = createCronProgram().commands.find((command) => command.name() === "edit");
    const help = editCommand?.helpInformation() ?? "";

    expect(help).toContain("--clear-channel");
    expect(help).toContain("--clear-to");
    expect(help).toContain("--clear-thread-id");
    expect(help).toContain("--clear-account");
  });

  it.each([
    ["--channel", "telegram"],
    ["--to", "+1234567890"],
    ["--account", "coordinator"],
    ["--thread-id", "42"],
  ])("rejects explicit chat delivery %s on main systemEvent cron edit", async (flag, value) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);
    const program = createCronProgram();

    await program.parseAsync(
      ["edit", "job-1", "--session", "main", "--system-event", "wakeup", flag, value],
      { from: "user" },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "--channel, --to, --account, and --thread-id require a non-main agentTurn or command job with delivery.",
      ),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
