import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import { registerCronCli } from "./cron-cli.js";

const CRON_CLI_TEST_TIMEOUT_MS = 15_000;
const mocks = vi.hoisted(() => {
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    callGatewayFromCli: vi.fn(),
  };
});

const { defaultRuntime, callGatewayFromCli } = mocks;

const defaultGatewayMock = async (
  method: string,
  _opts: unknown,
  params?: unknown,
  _timeoutMs?: number,
) => {
  if (method === "cron.status") {
    return { enabled: true };
  }
  return { ok: true, params };
};
callGatewayFromCli.mockImplementation(defaultGatewayMock);

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      mocks.callGatewayFromCli(method, opts, params, extra as number | undefined),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

type CronUpdatePatch = {
  patch?: {
    schedule?: { kind?: string; expr?: string; tz?: string; staggerMs?: number };
    payload?: {
      kind?: string;
      message?: string;
      model?: string;
      thinking?: string;
      lightContext?: boolean;
      toolsAllow?: string[];
    };
    delivery?: {
      mode?: string;
      channel?: string;
      to?: string;
      accountId?: string;
      bestEffort?: boolean;
    };
  };
};

type CronAddParams = {
  schedule?: { kind?: string; staggerMs?: number };
  payload?: {
    model?: string;
    thinking?: string;
    lightContext?: boolean;
    toolsAllow?: string[];
  };
  delivery?: { mode?: string; accountId?: string };
  deleteAfterRun?: boolean;
  agentId?: string;
  sessionTarget?: string;
};

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerCronCli(program);
  return program;
}

function createCronJob(id: string, name: string): CronJob {
  const now = Date.now();
  return {
    id,
    name,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3_600_000).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
  };
}

function resetGatewayMock() {
  callGatewayFromCli.mockClear();
  callGatewayFromCli.mockImplementation(defaultGatewayMock);
  defaultRuntime.log.mockClear();
  defaultRuntime.error.mockClear();
  defaultRuntime.writeStdout.mockClear();
  defaultRuntime.writeJson.mockClear();
  defaultRuntime.exit.mockClear();
}

async function runCronCommand(args: string[]): Promise<void> {
  resetGatewayMock();
  const program = buildProgram();
  await program.parseAsync(args, { from: "user" });
}

async function expectCronCommandExit(args: string[]): Promise<void> {
  await expect(runCronCommand(args)).rejects.toThrow("__exit__:1");
}

async function runCronEditAndGetPatch(editArgs: string[]): Promise<CronUpdatePatch> {
  await runCronCommand(["cron", "edit", "job-1", ...editArgs]);
  const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
  return (updateCall?.[2] ?? {}) as CronUpdatePatch;
}

async function runCronAddAndGetParams(addArgs: string[]): Promise<CronAddParams> {
  await runCronCommand(["cron", "add", ...addArgs]);
  const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
  return (addCall?.[2] ?? {}) as CronAddParams;
}

async function runCronSimpleAndGetUpdatePatch(
  command: "enable" | "disable",
): Promise<{ enabled?: boolean }> {
  await runCronCommand(["cron", command, "job-1"]);
  const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
  return ((updateCall?.[2] as { patch?: { enabled?: boolean } } | undefined)?.patch ?? {}) as {
    enabled?: boolean;
  };
}

function mockCronEditJobLookup(schedule: unknown): void {
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params?: unknown) => {
      if (method === "cron.status") {
        return { enabled: true };
      }
      if (method === "cron.list") {
        return {
          ok: true,
          params: {},
          jobs: [{ id: "job-1", schedule }],
        };
      }
      return { ok: true, params };
    },
  );
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets each assertion ascribe expected RPC params.
function getGatewayCallParams<T>(method: string): T {
  const call = callGatewayFromCli.mock.calls.find((entry) => entry[0] === method);
  return (call?.[2] ?? {}) as T;
}

async function runCronEditWithScheduleLookup(
  schedule: unknown,
  editArgs: string[],
): Promise<CronUpdatePatch> {
  resetGatewayMock();
  mockCronEditJobLookup(schedule);
  const program = buildProgram();
  await program.parseAsync(["cron", "edit", "job-1", ...editArgs], { from: "user" });
  return getGatewayCallParams<CronUpdatePatch>("cron.update");
}

async function expectCronEditWithScheduleLookupExit(
  schedule: unknown,
  editArgs: string[],
): Promise<void> {
  resetGatewayMock();
  mockCronEditJobLookup(schedule);
  const program = buildProgram();
  await expect(
    program.parseAsync(["cron", "edit", "job-1", ...editArgs], { from: "user" }),
  ).rejects.toThrow("__exit__:1");
}

async function runCronRunAndCaptureExit(params: {
  ran?: boolean;
  enqueued?: boolean;
  args?: string[];
}) {
  resetGatewayMock();
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, callParams?: unknown) => {
      if (method === "cron.status") {
        return { enabled: true };
      }
      if (method === "cron.run") {
        return {
          ok: true,
          params: callParams,
          ...(typeof params.ran === "boolean" ? { ran: params.ran } : {}),
          ...(typeof params.enqueued === "boolean" ? { enqueued: params.enqueued } : {}),
        };
      }
      return { ok: true, params: callParams };
    },
  );

  const runtime = defaultRuntime as { exit: (code: number) => void };
  const originalExit = runtime.exit;
  const exitSpy = vi.fn();
  runtime.exit = exitSpy;
  try {
    const program = buildProgram();
    await program.parseAsync(params.args ?? ["cron", "run", "job-1"], { from: "user" });
  } finally {
    runtime.exit = originalExit;
  }
  const runCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.run");
  return {
    exitSpy,
    runOpts: (runCall?.[1] ?? {}) as { timeout?: string },
  };
}

describe("cron cli", () => {
  it.each([
    {
      name: "exits 0 for cron run when job executes successfully",
      ran: true,
      expectedExitCode: 0,
    },
    {
      name: "exits 0 for cron run when job is queued successfully",
      enqueued: true,
      expectedExitCode: 0,
    },
    {
      name: "exits 1 for cron run when job does not execute",
      ran: false,
      expectedExitCode: 1,
    },
  ])("$name", async ({ ran, enqueued, expectedExitCode }) => {
    const { exitSpy } = await runCronRunAndCaptureExit({ ran, enqueued });
    expect(exitSpy).toHaveBeenCalledWith(expectedExitCode);
  });

  it("trims model and thinking on cron add", { timeout: CRON_CLI_TEST_TIMEOUT_MS }, async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Daily",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hello",
      "--model",
      "  opus  ",
      "--thinking",
      "  low  ",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as {
      payload?: { model?: string; thinking?: string };
    };

    expect(params?.payload?.model).toBe("opus");
    expect(params?.payload?.thinking).toBe("low");
  });

  it("defaults isolated cron add to announce delivery", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Daily",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hello",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { delivery?: { mode?: string } };

    expect(params?.delivery?.mode).toBe("announce");
  });

  it("infers sessionTarget from payload when --session is omitted", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Main reminder",
      "--cron",
      "* * * * *",
      "--system-event",
      "hi",
    ]);

    let addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    let params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("main");
    expect(params?.payload?.kind).toBe("systemEvent");

    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Isolated task",
      "--cron",
      "* * * * *",
      "--message",
      "hello",
    ]);

    addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.payload?.kind).toBe("agentTurn");
  });

  it("supports --keep-after-run on cron add", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Keep me",
      "--at",
      "20m",
      "--session",
      "main",
      "--system-event",
      "hello",
      "--keep-after-run",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { deleteAfterRun?: boolean };
    expect(params?.deleteAfterRun).toBe(false);
  });

  it("includes --account on isolated cron add delivery", async () => {
    const params = await runCronAddAndGetParams([
      "--name",
      "accounted add",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hello",
      "--account",
      "  coordinator  ",
    ]);
    expect(params?.delivery?.mode).toBe("announce");
    expect(params?.delivery?.accountId).toBe("coordinator");
  });

  it("rejects --account on non-isolated/systemEvent cron add", async () => {
    await expectCronCommandExit([
      "cron",
      "add",
      "--name",
      "invalid account add",
      "--cron",
      "* * * * *",
      "--session",
      "main",
      "--system-event",
      "tick",
      "--account",
      "coordinator",
    ]);
  });

  it.each([
    { command: "enable" as const, expectedEnabled: true },
    { command: "disable" as const, expectedEnabled: false },
  ])("cron $command sets enabled=$expectedEnabled patch", async ({ command, expectedEnabled }) => {
    const patch = await runCronSimpleAndGetUpdatePatch(command);
    expect(patch.enabled).toBe(expectedEnabled);
  });

  it("paginates cron show lookups", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.status") {
          return { enabled: true };
        }
        if (method === "cron.list") {
          const offset = (params as { offset?: number }).offset ?? 0;
          if (offset === 0) {
            return {
              jobs: [createCronJob("first-page", "First Page")],
              hasMore: true,
              nextOffset: 200,
            };
          }
          return {
            jobs: [createCronJob("target-job", "Target Job")],
            hasMore: false,
            nextOffset: null,
            deliveryPreviews: {
              "target-job": {
                label: "announce -> telegram:-100",
                detail: "resolved from last, main session",
              },
            },
          };
        }
        return { ok: true, params };
      },
    );

    const program = buildProgram();
    await program.parseAsync(["cron", "show", "Target Job"], { from: "user" });

    const listParams = callGatewayFromCli.mock.calls
      .filter((call) => call[0] === "cron.list")
      .map((call) => call[2]);
    expect(listParams).toEqual([
      { includeDisabled: true, limit: 200, offset: 0 },
      { includeDisabled: true, limit: 200, offset: 200 },
    ]);
    expect(defaultRuntime.log).toHaveBeenCalledWith("id: target-job");
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      "delivery: announce -> telegram:-100 (resolved from last, main session)",
    );
  });

  it("sends agent id on cron add", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Agent pinned",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hi",
      "--agent",
      "ops",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { agentId?: string };
    expect(params?.agentId).toBe("ops");
  });

  it("sets lightContext on cron add when --light-context is passed", async () => {
    const params = await runCronAddAndGetParams([
      "--name",
      "Light context",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hello",
      "--light-context",
    ]);

    expect(params?.payload?.lightContext).toBe(true);
  });

  it("splits PowerShell-style space-separated --tools on cron add", async () => {
    const params = await runCronAddAndGetParams([
      "--name",
      "Tools",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hello",
      "--tools",
      "exec read write",
    ]);

    expect(params?.payload?.toolsAllow).toEqual(["exec", "read", "write"]);
  });

  it.each([
    {
      label: "omits empty model and thinking",
      args: ["--message", "hello", "--model", "   ", "--thinking", "  "],
      expectedModel: undefined,
      expectedThinking: undefined,
    },
    {
      label: "trims model and thinking",
      args: ["--message", "hello", "--model", "  opus  ", "--thinking", "  high  "],
      expectedModel: "opus",
      expectedThinking: "high",
    },
  ])("cron edit $label", async ({ args, expectedModel, expectedThinking }) => {
    const patch = await runCronEditAndGetPatch(args);
    expect(patch?.patch?.payload?.model).toBe(expectedModel);
    expect(patch?.patch?.payload?.thinking).toBe(expectedThinking);
  });

  it("splits PowerShell-style space-separated --tools on cron edit", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "hello",
      "--tools",
      "exec read write",
    ]);

    expect(patch?.patch?.payload?.toolsAllow).toEqual(["exec", "read", "write"]);
  });

  it("sets and clears agent id on cron edit", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--agent", " Ops ", "--message", "hello"]);

    const patch = getGatewayCallParams<{ patch?: { agentId?: unknown } }>("cron.update");
    expect(patch?.patch?.agentId).toBe("ops");

    await runCronCommand(["cron", "edit", "job-2", "--clear-agent"]);
    const clearPatch = getGatewayCallParams<{ patch?: { agentId?: unknown } }>("cron.update");
    expect(clearPatch?.patch?.agentId).toBeNull();
  });

  it("allows model/thinking updates without --message", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--model", "opus", "--thinking", "low"]);

    const patch = getGatewayCallParams<{
      patch?: { payload?: { kind?: string; model?: string; thinking?: string } };
    }>("cron.update");

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("low");
  });

  it("sets and clears lightContext on cron edit", async () => {
    const setPatch = await runCronEditAndGetPatch(["--light-context", "--message", "hello"]);
    expect(setPatch?.patch?.payload?.lightContext).toBe(true);

    const clearPatch = await runCronEditAndGetPatch(["--no-light-context", "--message", "hello"]);
    expect(clearPatch?.patch?.payload?.lightContext).toBe(false);
  });

  it("updates delivery settings without requiring --message", async () => {
    await runCronCommand([
      "cron",
      "edit",
      "job-1",
      "--deliver",
      "--channel",
      "telegram",
      "--to",
      "19098680",
    ]);

    const patch = getGatewayCallParams<{
      patch?: {
        payload?: { kind?: string; message?: string };
        delivery?: { mode?: string; channel?: string; to?: string };
      };
    }>("cron.update");

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
    expect(patch?.patch?.payload?.message).toBeUndefined();
  });

  it("supports --no-deliver on cron edit", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--no-deliver"]);

    const patch = getGatewayCallParams<{
      patch?: { payload?: { kind?: string }; delivery?: { mode?: string } };
    }>("cron.update");

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("none");
  });

  it("updates delivery account without requiring --message on cron edit", async () => {
    const patch = await runCronEditAndGetPatch(["--account", "  coordinator  "]);
    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.accountId).toBe("coordinator");
    expect(patch?.patch?.delivery?.mode).toBeUndefined();
  });

  it("does not include undefined delivery fields when updating message", async () => {
    // Update message without delivery flags - should NOT include undefined delivery fields
    await runCronCommand(["cron", "edit", "job-1", "--message", "Updated message"]);

    const patch = getGatewayCallParams<{
      patch?: {
        payload?: {
          message?: string;
          deliver?: boolean;
          channel?: string;
          to?: string;
          bestEffortDeliver?: boolean;
        };
        delivery?: unknown;
      };
    }>("cron.update");

    // Should include the new message
    expect(patch?.patch?.payload?.message).toBe("Updated message");

    // Should NOT include delivery fields at all (to preserve existing values)
    expect(patch?.patch?.payload).not.toHaveProperty("deliver");
    expect(patch?.patch?.payload).not.toHaveProperty("channel");
    expect(patch?.patch?.payload).not.toHaveProperty("to");
    expect(patch?.patch?.payload).not.toHaveProperty("bestEffortDeliver");
    expect(patch?.patch).not.toHaveProperty("delivery");
  });

  it("includes delivery fields when explicitly provided with message", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "Updated message",
      "--deliver",
      "--channel",
      "telegram",
      "--to",
      "19098680",
    ]);

    // Should include everything
    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
  });

  it.each([
    { flag: "--best-effort-deliver", expectedBestEffort: true },
    { flag: "--no-best-effort-deliver", expectedBestEffort: false },
  ])("applies $flag on cron edit message updates", async ({ flag, expectedBestEffort }) => {
    const patch = await runCronEditAndGetPatch(["--message", "Updated message", flag]);
    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.bestEffort).toBe(expectedBestEffort);
  });

  it("sets explicit stagger for cron add", async () => {
    const params = await runCronAddAndGetParams([
      "--name",
      "staggered",
      "--cron",
      "0 * * * *",
      "--stagger",
      "45s",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
    expect(params?.schedule?.kind).toBe("cron");
    expect(params?.schedule?.staggerMs).toBe(45_000);
  });

  it("sets exact cron mode on add", async () => {
    const params = await runCronAddAndGetParams([
      "--name",
      "exact",
      "--cron",
      "0 * * * *",
      "--exact",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
    expect(params?.schedule?.kind).toBe("cron");
    expect(params?.schedule?.staggerMs).toBe(0);
  });

  it("rejects --stagger with --exact on add", async () => {
    await expectCronCommandExit([
      "cron",
      "add",
      "--name",
      "invalid",
      "--cron",
      "0 * * * *",
      "--stagger",
      "1m",
      "--exact",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
  });

  it("rejects --stagger when schedule is not cron", async () => {
    await expectCronCommandExit([
      "cron",
      "add",
      "--name",
      "invalid",
      "--every",
      "10m",
      "--stagger",
      "30s",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
  });

  it("rejects --tz with --every on cron add", async () => {
    await expectCronCommandExit([
      "cron",
      "add",
      "--name",
      "invalid",
      "--every",
      "10m",
      "--tz",
      "UTC",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
  });

  it("applies --tz to --at for offset-less datetimes on cron add", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "tz-at-test",
      "--at",
      "2026-03-23T23:00:00",
      "--tz",
      "Europe/Oslo",
      "--session",
      "isolated",
      "--message",
      "test",
    ]);

    const params = getGatewayCallParams<{ schedule: { kind: string; at: string } }>("cron.add");
    // 2026-03-23 is CET (+01:00), so 23:00 Oslo = 22:00 UTC
    expect(params.schedule.kind).toBe("at");
    expect(params.schedule.at).toBe("2026-03-23T22:00:00.000Z");
  });

  it("does not apply --tz when --at already has an offset", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "tz-at-offset-test",
      "--at",
      "2026-03-23T23:00:00+02:00",
      "--tz",
      "Europe/Oslo",
      "--session",
      "isolated",
      "--message",
      "test",
    ]);

    const params = getGatewayCallParams<{ schedule: { kind: string; at: string } }>("cron.add");
    // Explicit +02:00 should be honored, not overridden by --tz
    expect(params.schedule.kind).toBe("at");
    expect(params.schedule.at).toBe("2026-03-23T21:00:00.000Z");
  });

  it("applies --tz to --at correctly across DST boundaries on cron add", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "tz-at-dst-test",
      "--at",
      "2026-03-29T01:30:00",
      "--tz",
      "Europe/Oslo",
      "--session",
      "isolated",
      "--message",
      "test",
    ]);

    const params = getGatewayCallParams<{ schedule: { kind: string; at: string } }>("cron.add");
    expect(params.schedule.kind).toBe("at");
    expect(params.schedule.at).toBe("2026-03-29T00:30:00.000Z");
  });

  it("rejects nonexistent DST gap wall-clock times on cron add", async () => {
    await expectCronCommandExit([
      "cron",
      "add",
      "--name",
      "tz-at-gap-test",
      "--at",
      "2026-03-29T02:30:00",
      "--tz",
      "Europe/Oslo",
      "--session",
      "isolated",
      "--message",
      "test",
    ]);
  });

  it("sets explicit stagger for cron edit", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--cron", "0 * * * *", "--stagger", "30s"]);

    const patch = getGatewayCallParams<{
      patch?: { schedule?: { kind?: string; staggerMs?: number } };
    }>("cron.update");
    expect(patch?.patch?.schedule?.kind).toBe("cron");
    expect(patch?.patch?.schedule?.staggerMs).toBe(30_000);
  });

  it("applies --exact to existing cron job without requiring --cron on edit", async () => {
    const patch = await runCronEditWithScheduleLookup(
      { kind: "cron", expr: "0 */2 * * *", tz: "UTC", staggerMs: 300_000 },
      ["--exact"],
    );
    expect(patch?.patch?.schedule).toEqual({
      kind: "cron",
      expr: "0 */2 * * *",
      tz: "UTC",
      staggerMs: 0,
    });
  });

  it("rejects --exact on edit when existing job is not cron", async () => {
    await expectCronEditWithScheduleLookupExit({ kind: "every", everyMs: 60_000 }, ["--exact"]);
  });

  it("applies --tz to --at for offset-less datetimes on cron edit", async () => {
    const patch = await runCronEditAndGetPatch([
      "--at",
      "2026-03-23T23:00:00",
      "--tz",
      "Europe/Oslo",
    ]);

    expect(patch?.patch?.schedule).toEqual({
      kind: "at",
      at: "2026-03-23T22:00:00.000Z",
    });
  });

  it("rejects --tz with --every on cron edit", async () => {
    await expectCronCommandExit(["cron", "edit", "job-1", "--every", "10m", "--tz", "UTC"]);
  });

  it("patches failure alert settings on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const program = buildProgram();

    await program.parseAsync(
      [
        "cron",
        "edit",
        "job-1",
        "--failure-alert-after",
        "3",
        "--failure-alert-cooldown",
        "1h",
        "--failure-alert-channel",
        "telegram",
        "--failure-alert-to",
        "19098680",
      ],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        failureAlert?: { after?: number; cooldownMs?: number; channel?: string; to?: string };
      };
    };

    expect(patch?.patch?.failureAlert?.after).toBe(3);
    expect(patch?.patch?.failureAlert?.cooldownMs).toBe(3_600_000);
    expect(patch?.patch?.failureAlert?.channel).toBe("telegram");
    expect(patch?.patch?.failureAlert?.to).toBe("19098680");
  });

  it("supports --no-failure-alert on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const program = buildProgram();

    await program.parseAsync(["cron", "edit", "job-1", "--no-failure-alert"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as { patch?: { failureAlert?: boolean } };
    expect(patch?.patch?.failureAlert).toBe(false);
  });

  it("patches failure alert mode/accountId on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const program = buildProgram();

    await program.parseAsync(
      [
        "cron",
        "edit",
        "job-1",
        "--failure-alert-after",
        "1",
        "--failure-alert-mode",
        "webhook",
        "--failure-alert-account-id",
        "bot-a",
      ],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        failureAlert?: {
          after?: number;
          mode?: "announce" | "webhook";
          accountId?: string;
        };
      };
    };

    expect(patch?.patch?.failureAlert?.after).toBe(1);
    expect(patch?.patch?.failureAlert?.mode).toBe("webhook");
    expect(patch?.patch?.failureAlert?.accountId).toBe("bot-a");
  });
});
