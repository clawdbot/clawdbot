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

  it("reuses one versioned snapshot for combined pacing and tool edits", async () => {
    const configRevision = "current-job-revision";
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          configRevision,
          pacing: { min: "15m", max: "4h" },
          payload: { kind: "agentTurn", message: "hello" },
        };
      }
      return { ok: true };
    });

    await createCronProgram().parseAsync(
      ["edit", "job-1", "--pacing-min", "30m", "--tools", "read"],
      { from: "user" },
    );

    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.get")).toHaveLength(
      1,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        pacing: { min: "30m", max: "4h" },
        payload: { kind: "agentTurn", toolsAllow: ["read"] },
      },
      expectedConfigRevision: configRevision,
    });
  });

  it.each(["read", ""])("rejects --tools %j combined with --clear-tools", async (tools) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);

    try {
      await createCronProgram().parseAsync(
        ["edit", "job-1", "--pacing-min", "30m", "--tools", tools, "--clear-tools"],
        { from: "user" },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Use --tools or --clear-tools, not both"),
      );
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it.each([
    {
      label: "empty --agent",
      args: ["--agent", ""],
      message: "--agent must not be blank",
    },
    {
      label: "whitespace --agent",
      args: ["--agent", "   "],
      message: "--agent must not be blank",
    },
    {
      label: "empty --agent with --clear-agent",
      args: ["--agent", "", "--clear-agent"],
      message: "--agent must not be blank",
    },
    {
      label: "whitespace --agent with --clear-agent",
      args: ["--agent", "   ", "--clear-agent"],
      message: "--agent must not be blank",
    },
    {
      label: "--agent with --clear-agent",
      args: ["--agent", "main", "--clear-agent"],
      message: "Use --agent or --clear-agent, not both",
    },
    {
      label: "empty --session-key",
      args: ["--session-key", ""],
      message: "--session-key must not be blank",
    },
    {
      label: "whitespace --session-key",
      args: ["--session-key", "   "],
      message: "--session-key must not be blank",
    },
    {
      label: "empty --session-key with --clear-session-key",
      args: ["--session-key", "", "--clear-session-key"],
      message: "--session-key must not be blank",
    },
    {
      label: "whitespace --session-key with --clear-session-key",
      args: ["--session-key", "   ", "--clear-session-key"],
      message: "--session-key must not be blank",
    },
    {
      label: "--session-key with --clear-session-key",
      args: ["--session-key", "agent:main:main", "--clear-session-key"],
      message: "Use --session-key or --clear-session-key, not both",
    },
  ])("rejects $label", async ({ args, message }) => {
    await expectCronEditRejection(args, message);
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

  it.each([
    {
      kind: "agentTurn",
      payload: { kind: "agentTurn", message: "hello" },
    },
    {
      kind: "command",
      payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
    },
  ])("preserves $kind payload kind for timeout-only edits", async ({ kind, payload }) => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return { id: "job-1", payload };
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
            kind,
            timeoutSeconds: 12,
          },
        },
      },
    );
  });

  it.each([
    {
      kind: "script",
      payload: { kind: "script", script: "return { notify: 'hello' }", timeoutSeconds: 5 },
      error: "Use --script-timeout-seconds for script jobs",
    },
    {
      kind: "systemEvent",
      payload: { kind: "systemEvent", text: "hello" },
      error: "--timeout-seconds is not supported for systemEvent jobs",
    },
    {
      kind: "heartbeat",
      payload: { kind: "heartbeat" },
      error: "--timeout-seconds is not supported for heartbeat jobs",
    },
  ])(
    "rejects timeout-only edits for stored $kind payloads before cron.update",
    async ({ payload, error }) => {
      callGatewayFromCli.mockImplementation(async (method: string) => {
        if (method === "cron.get") {
          return { id: "job-1", payload };
        }
        return { ok: true };
      });
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(defaultRuntime, "exit")
        .mockImplementation((() => undefined) as never);

      try {
        await createCronProgram().parseAsync(["edit", "job-1", "--timeout-seconds", "12"], {
          from: "user",
        });

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(error));
        expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
          id: "job-1",
        });
        expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.update")).toBe(
          false,
        );
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
    },
  );

  it("rejects generic timeout combined with an explicit systemEvent before cron.update", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);

    try {
      await createCronProgram().parseAsync(
        ["edit", "job-1", "--system-event", "hello", "--timeout-seconds", "12"],
        { from: "user" },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--timeout-seconds is not supported for systemEvent jobs"),
      );
      expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.update")).toBe(
        false,
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it.each([
    ["--script", "missing-script.js"],
    ["--script-tool-budget", "3"],
    ["--script-timeout-seconds", "20"],
  ])(
    "rejects generic timeout combined with script option %s before cron.update",
    async (flag, value) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(defaultRuntime, "exit")
        .mockImplementation((() => undefined) as never);

      try {
        await createCronProgram().parseAsync(
          ["edit", "job-1", "--timeout-seconds", "12", flag, value],
          { from: "user" },
        );

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Use --script-timeout-seconds for script jobs"),
        );
        expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.update")).toBe(
          false,
        );
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
    },
  );

  it("updates script timeout with the script-specific option", async () => {
    await createCronProgram().parseAsync(["edit", "job-1", "--script-timeout-seconds", "20"], {
      from: "user",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ scriptTimeoutSeconds: "20" }),
      {
        id: "job-1",
        patch: {
          payload: {
            kind: "script",
            timeoutSeconds: 20,
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

  it("stores an explicit wildcard with --clear-tools", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return { id: "job-1", payload: { kind: "agentTurn", message: "hello" } };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-tools"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearTools: true }),
      {
        id: "job-1",
        patch: {
          payload: {
            kind: "agentTurn",
            toolsAllow: ["*"],
          },
        },
      },
    );
  });

  it.each([
    { kind: "agentTurn", payload: { kind: "agentTurn", message: "hello" } },
    { kind: "command", payload: { kind: "command", argv: ["echo", "hello"] } },
    { kind: "script", payload: { kind: "script", script: "return { notify: 'hello' }" } },
    { kind: "systemEvent", payload: { kind: "systemEvent", text: "hello" } },
  ])("preserves $kind payloads when editing their tool allowlist", async ({ kind, payload }) => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return { id: "job-1", payload };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--tools", "read,write"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
      id: "job-1",
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { payload: { kind, toolsAllow: ["read", "write"] } },
    });
  });

  it.each([
    { kind: "agentTurn", payload: { kind: "agentTurn", message: "hello" } },
    { kind: "command", payload: { kind: "command", argv: ["echo", "hello"] } },
    { kind: "script", payload: { kind: "script", script: "return { notify: 'hello' }" } },
    { kind: "systemEvent", payload: { kind: "systemEvent", text: "hello" } },
  ])("preserves $kind payloads when clearing their tool allowlist", async ({ kind, payload }) => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return { id: "job-1", payload };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--clear-tools"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { payload: { kind, toolsAllow: ["*"] } },
    });
  });

  it.each([
    {
      label: "command with a restricted allowlist",
      payload: { kind: "command", argv: ["echo", "hello"] },
      toolArgs: ["--tools", "read,write"],
      toolsAllow: ["read", "write"],
    },
    {
      label: "command with a cleared allowlist",
      payload: { kind: "command", argv: ["echo", "hello"] },
      toolArgs: ["--clear-tools"],
      toolsAllow: ["*"],
    },
    {
      label: "agent turn with a restricted allowlist",
      payload: { kind: "agentTurn", message: "hello" },
      toolArgs: ["--tools", "read,write"],
      toolsAllow: ["read", "write"],
    },
    {
      label: "agent turn with a cleared allowlist",
      payload: { kind: "agentTurn", message: "hello" },
      toolArgs: ["--clear-tools"],
      toolsAllow: ["*"],
    },
  ])(
    "preserves the existing $label when editing its timeout",
    async ({ payload, toolArgs, toolsAllow }) => {
      callGatewayFromCli.mockImplementation(async (method: string) => {
        if (method === "cron.get") {
          return { id: "job-1", payload };
        }
        return { ok: true };
      });
      const program = createCronProgram();

      await program.parseAsync(["edit", "job-1", "--timeout-seconds", "12", ...toolArgs], {
        from: "user",
      });

      expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
        id: "job-1",
      });
      expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
        id: "job-1",
        patch: {
          payload: {
            kind: payload.kind,
            timeoutSeconds: 12,
            toolsAllow,
          },
        },
      });
    },
  );

  it("keeps explicit conversational payload changes independent of existing job reads", async () => {
    const program = createCronProgram();

    await program.parseAsync(
      ["edit", "job-1", "--message", "new message", "--timeout-seconds", "12", "--tools", "read"],
      { from: "user" },
    );

    expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.get")).toBe(false);
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        payload: {
          kind: "agentTurn",
          message: "new message",
          timeoutSeconds: 12,
          toolsAllow: ["read"],
        },
      },
    });
  });

  it.each([
    { duration: "0", cooldownMs: 0 },
    { duration: "0s", cooldownMs: 0 },
    { duration: "0m", cooldownMs: 0 },
    { duration: "30s", cooldownMs: 30_000 },
    { duration: "1h30m", cooldownMs: 5_400_000 },
  ])("accepts failure alert cooldown $duration", async ({ duration, cooldownMs }) => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--failure-alert-cooldown", duration], {
      from: "user",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { failureAlert: { cooldownMs } },
    });
  });

  it.each(["-1s", "not-a-duration", "999999999999999999d"])(
    "rejects invalid failure alert cooldown %s",
    async (duration) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(defaultRuntime, "exit")
        .mockImplementation((() => undefined) as never);
      const program = createCronProgram();

      try {
        await program.parseAsync(["edit", "job-1", "--failure-alert-cooldown", duration], {
          from: "user",
        });

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Invalid --failure-alert-cooldown."),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
    },
  );

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
