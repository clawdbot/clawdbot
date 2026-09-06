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

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");

function createMutationProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronAddCommand(program);
  registerCronEditCommand(program);
  return program;
}

const topicMutationCases = [
  {
    operation: "add",
    method: "cron.add",
    args: [
      "add",
      "--name",
      "topic-proof",
      "--every",
      "1m",
      "--agent",
      "main",
      "--message",
      "hello",
      "--channel",
      "telegram",
      "--to",
      "group-123",
    ],
  },
  {
    operation: "edit",
    method: "cron.update",
    args: ["edit", "job-1", "--channel", "telegram", "--to", "group-123"],
  },
] as const;

describe("shared automation mutation options", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it.each([
    { operation: "add", flag: "--every" },
    { operation: "add", flag: "--stagger" },
    { operation: "edit", flag: "--every" },
    { operation: "edit", flag: "--stagger" },
  ])(
    "rejects out-of-range configured duration precision for $operation $flag before RPC",
    async ({ operation, flag }) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const args =
        operation === "add"
          ? [
              "add",
              "--name",
              "Duration boundary",
              "--agent",
              "main",
              "--system-event",
              "test",
              "--disabled",
            ]
          : ["edit", "job-1"];
      try {
        await expect(
          createMutationProgram().parseAsync(
            [
              ...args,
              ...(flag === "--stagger" ? ["--cron", "0 * * * *", "--tz", "UTC"] : []),
              flag,
              "8640000000000001ms",
            ],
            { from: "user" },
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`Invalid ${flag}`));
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(["--every", "--stagger"])(
    "accepts the inclusive configured duration precision limit for %s",
    async (flag) => {
      await createMutationProgram().parseAsync(
        [
          "add",
          "--name",
          "Duration boundary",
          "--agent",
          "main",
          "--system-event",
          "test",
          "--disabled",
          ...(flag === "--stagger" ? ["--cron", "0 * * * *"] : []),
          flag,
          "8640000000000000ms",
        ],
        { from: "user" },
      );

      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({
          enabled: false,
          schedule:
            flag === "--every"
              ? { kind: "every", everyMs: 8_640_000_000_000_000 }
              : {
                  kind: "cron",
                  expr: "0 * * * *",
                  tz: undefined,
                  staggerMs: 8_640_000_000_000_000,
                },
        }),
      );
    },
  );

  it("updates an existing automation to an exit-triggered schedule", async () => {
    await createMutationProgram().parseAsync(
      ["edit", "job-1", "--on-exit", "./watch.sh", "--on-exit-cwd", "/repo"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { schedule: { kind: "on-exit", command: "./watch.sh", cwd: "/repo" } },
    });
  });

  it.each([
    [["--on-exit-cwd", "/repo"], "--on-exit-cwd requires --on-exit"],
    [["--on-exit", "./watch.sh", "--every", "5m"], "Choose at most one schedule change"],
  ])("rejects invalid exit-triggered schedule options", async (args, message) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      await expect(
        createMutationProgram().parseAsync(["edit", "job-1", ...args], { from: "user" }),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(
    topicMutationCases.flatMap((mutation) =>
      ["", "   "].map((threadId) => ({
        operation: mutation.operation,
        args: mutation.args,
        threadId,
      })),
    ),
  )(
    "rejects blank thread id $threadId before automation $operation",
    async ({ args, threadId }) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        await expect(
          createMutationProgram().parseAsync([...args, "--thread-id", threadId], {
            from: "user",
          }),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--thread-id must be a positive integer"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(topicMutationCases)(
    "preserves omitted and maximum-safe topic ids on automation $operation",
    async ({ operation, method, args }) => {
      for (const threadId of [undefined, Number.MAX_SAFE_INTEGER]) {
        callGatewayFromCli.mockClear();
        await createMutationProgram().parseAsync(
          [...args, ...(threadId === undefined ? [] : ["--thread-id", String(threadId)])],
          { from: "user" },
        );
        const call = callGatewayFromCli.mock.calls.find(
          ([calledMethod]) => calledMethod === method,
        );
        const request = call?.[2] as {
          delivery?: { threadId?: number };
          patch?: { delivery?: { threadId?: number } };
        };
        const delivery = operation === "add" ? request.delivery : request.patch?.delivery;
        expect(delivery?.threadId).toBe(threadId);
      }
    },
  );

  it.each(["", "   ", "topic-42"])(
    "rejects invalid thread id %j before loading an automation for a combined edit",
    async (threadId) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        await expect(
          createMutationProgram().parseAsync(
            [
              "edit",
              "job-1",
              "--pacing-min",
              "30m",
              "--channel",
              "telegram",
              "--to",
              "group-123",
              "--thread-id",
              threadId,
            ],
            { from: "user" },
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--thread-id must be a positive integer"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("keeps creation defaults out of automation edit patches", () => {
    const program = createMutationProgram();
    const add = program.commands.find((command) => command.name() === "add")!;
    const edit = program.commands.find((command) => command.name() === "edit")!;
    const creationDefaults: Array<[string, string | boolean]> = [
      ["wake", "now"],
      ["tz", ""],
      ["exact", false],
      ["lightContext", false],
      ["announce", false],
      ["channel", "last"],
      ["bestEffortDeliver", false],
    ];

    for (const [name, value] of creationDefaults) {
      expect(add.getOptionValue(name)).toBe(value);
      expect(edit.getOptionValue(name)).toBeUndefined();
    }
  });
});
