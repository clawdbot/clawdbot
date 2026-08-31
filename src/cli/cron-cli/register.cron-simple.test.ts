// Cron simple register tests cover basic cron command registration and execution.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { defaultRuntime } from "../../runtime.js";
import { isCommandJsonOutputMode } from "../program/json-mode.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { isCronMachineOutput } = await import("./output-mode.js");
const { registerCronCli } = await import("./register.js");
const { registerCronSimpleCommands } = await import("./register.cron-simple.js");
const originalStderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

async function runCronShow(id: string): Promise<void> {
  const cron = new Command();
  registerCronSimpleCommands(cron);
  await cron.parseAsync(["show", id, "--json"], { from: "user" });
}

async function runCronToggle(command: "enable" | "disable"): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCronSimpleCommands(program);
  await program.parseAsync([command, "job-1"], { from: "user" });
}

function mockCronShowPages(readPage: (params: { offset?: number }) => unknown): void {
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params?: { id?: string; offset?: number }) => {
      if (method === "cron.get") {
        // Mirrors the gateway's stable wire wording; older shipped CLI matchers
        // parse exactly this form, so the server must not reword it.
        throw Object.assign(new Error(`cron job not found: ${params?.id ?? ""}`), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
        });
      }
      if (method === "cron.list") {
        return readPage(params ?? {});
      }
      throw new Error(`unexpected cron method: ${method}`);
    },
  );
}

function setStderrIsTTY(value: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", {
    value,
    configurable: true,
  });
}

function restoreStderrIsTTY(): void {
  if (originalStderrIsTTY) {
    Object.defineProperty(process.stderr, "isTTY", originalStderrIsTTY);
  } else {
    Reflect.deleteProperty(process.stderr, "isTTY");
  }
}

function createRegisteredCronCommand(): Command {
  const program = new Command().name("openclaw");
  registerCronCli(program);
  const cron = program.commands.find((command) => command.name() === "cron");
  if (!cron) {
    throw new Error("cron command was not registered");
  }
  return cron;
}

describe("cron machine-output help", () => {
  it.each([
    { name: "status", aliases: [] },
    { name: "add", aliases: ["create"] },
    { name: "rm", aliases: ["remove", "delete"] },
    { name: "enable", aliases: [] },
    { name: "disable", aliases: [] },
    { name: "get", aliases: [] },
    { name: "runs", aliases: [] },
    { name: "run", aliases: [] },
    { name: "edit", aliases: [] },
  ])("documents $name as always-JSON machine output", ({ name, aliases }) => {
    const command = createRegisteredCronCommand().commands.find((candidate) =>
      [candidate.name(), ...candidate.aliases()].includes(name),
    );
    const jsonOption = command?.options.find((option) => option.long === "--json");

    expect(command?.aliases()).toEqual(aliases);
    expect(jsonOption?.description).toBe(
      "Explicit machine-output spelling (command results are JSON by default)",
    );
    expect(jsonOption?.defaultValue).toBeUndefined();
    for (const commandName of [name, ...aliases]) {
      expect(isCronMachineOutput(["node", "openclaw", "cron", commandName])).toBe(true);
    }
  });

  it("keeps registered command output declarations aligned with early stdout routing", () => {
    const cron = createRegisteredCronCommand();
    const gatewayOptions = [
      [],
      ["--url", "ws://127.0.0.1:18789"],
      ["--port", "18789"],
      ["--token", "test-token"],
      ["--password", "test-password"],
      ["--timeout", "250"],
      ["--expect-final"],
      ["--port=18789"],
      ["--timeout", "250", "--expect-final"],
      ["--log-level", "debug", "--port", "18789"],
    ];
    for (const command of cron.commands) {
      const jsonOption = command.options.find((option) => option.long === "--json");
      const alwaysJson =
        jsonOption?.description ===
        "Explicit machine-output spelling (command results are JSON by default)";
      const reservesMachineOutput = command.name() === "scratch" || alwaysJson;
      for (const commandName of [command.name(), ...command.aliases()]) {
        for (const root of ["cron", "automations"]) {
          for (const parentOptions of gatewayOptions) {
            const argv = ["node", "openclaw", root, ...parentOptions, commandName];
            expect(isCronMachineOutput(argv), argv.join(" ")).toBe(reservesMachineOutput);
          }
        }
      }
    }
  });

  it.each([
    { root: "cron", option: "--timeout", value: "250" },
    { root: "automations", option: "--port", value: "18789" },
    { root: "automations", option: "--url", value: "ws://127.0.0.1:18789" },
    { root: "cron", option: "--token", value: "test-token" },
    { root: "cron", option: "--password", value: "test-password" },
  ])("preserves JSON mode for $root $option before status", async ({ root, option, value }) => {
    const program = new Command().name("openclaw");
    registerCronCli(program);
    const argv = ["node", "openclaw", root, option, value, "status"];
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    callGatewayFromCli.mockResolvedValueOnce({ enabled: true });
    program.hook("preAction", (_parent, command) => {
      expect(isCommandJsonOutputMode(command, argv)).toBe(true);
    });

    try {
      await program.parseAsync(argv);
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.status",
        expect.objectContaining({ [option.slice(2)]: value }),
        {},
      );
      expect(writeJson).toHaveBeenCalledWith({ enabled: true });
    } finally {
      callGatewayFromCli.mockReset();
      writeJson.mockRestore();
    }
  });
});

describe("cron show pagination guard (regression for #83856)", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when nextOffset fails to advance", async () => {
    mockCronShowPages(() => ({
      jobs: [],
      snapshotRevision: "test-stable-cron-inventory",
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: true,
      nextOffset: 0,
    }));
    await expect(runCronShow("missing")).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("pagination did not advance"),
    );
    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
      1,
    );
  });

  it("throws when pagination exceeds the max page count", async () => {
    mockCronShowPages(({ offset = 0 }) => {
      return {
        jobs: [{ id: `page-${offset}`, name: `Page ${offset}` }],
        snapshotRevision: "test-stable-cron-inventory",
        total: 51,
        offset,
        limit: 200,
        hasMore: true,
        nextOffset: offset + 1,
      };
    });
    await expect(runCronShow("missing")).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("pagination exceeded maximum pages"),
    );
    const listCalls = callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list");
    expect(listCalls.length).toBeGreaterThan(1);
    expect(listCalls.length).toBeLessThanOrEqual(50);
  });

  it("returns the job when found on a later page", async () => {
    const job: CronJob = { id: "abc", name: "wanted" } as unknown as CronJob;
    mockCronShowPages(({ offset }) =>
      offset
        ? {
            jobs: [job],
            snapshotRevision: "test-stable-cron-inventory",
            total: 201,
            offset,
            limit: 200,
            hasMore: false,
            nextOffset: null,
          }
        : {
            jobs: Array.from({ length: 200 }, (_, index) => ({
              id: `page-${index}`,
              name: `Page ${index}`,
            })),
            snapshotRevision: "test-stable-cron-inventory",
            total: 201,
            offset: 0,
            limit: 200,
            hasMore: true,
            nextOffset: 200,
          },
    );
    await runCronShow("wanted");
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ id: "abc" }));
    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
      2,
    );
  });

  it("uses the canonical lookup miss when pagination terminates without a match", async () => {
    mockCronShowPages(() => ({
      jobs: [],
      snapshotRevision: "test-empty-cron-inventory",
      total: 0,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    }));
    await expect(runCronShow("missing")).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Automation not found: missing. Run `openclaw cron list` to see recent automation ids.",
      ),
    );
  });
});

describe("cron disable hint", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.status") {
        return { enabled: true };
      }
      return { ok: true };
    });
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreStderrIsTTY();
    vi.restoreAllMocks();
  });

  it.each([
    { command: "disable" as const, tty: false, expectedHint: false },
    { command: "disable" as const, tty: true, expectedHint: true },
    { command: "enable" as const, tty: true, expectedHint: false },
  ])("$command with stderr TTY=$tty emits hint=$expectedHint", async (params) => {
    setStderrIsTTY(params.tty);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCronToggle(params.command);

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { enabled: params.command === "enable" },
    });
    if (params.expectedHint) {
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("openclaw cron list --all"));
    } else {
      expect(stderrWrite).not.toHaveBeenCalled();
    }
  });
});

describe("cron scheduler status warnings", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { status: undefined, disabled: false },
    { status: null, disabled: false },
    { status: {}, disabled: false },
    { status: { enabled: true }, disabled: false },
    { status: { enabled: false }, disabled: true },
  ])("warns only when scheduler disabled is known ($status)", async ({ status, disabled }) => {
    callGatewayFromCli.mockImplementation(async (method: string) =>
      method === "cron.status" ? status : { ok: true },
    );

    await runCronToggle("enable");

    if (disabled) {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("scheduler is disabled"),
      );
    } else {
      expect(defaultRuntime.error).not.toHaveBeenCalled();
    }
  });
});
