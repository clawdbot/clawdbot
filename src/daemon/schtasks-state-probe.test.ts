// Scheduled Task state probe tests cover the Task Scheduler probe command contract.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";

type SpawnSyncResult = {
  pid: number;
  output: (string | null)[];
  stdout: string;
  stderr: string;
  status: number | null;
  signal: null;
  error?: Error;
};

type SpawnSyncOptions = {
  input?: string | Buffer;
  encoding?: string;
  timeout?: number;
  windowsHide?: boolean;
};

const spawnSync = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions,
    ) => SpawnSyncResult | undefined
  >(),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync,
  };
});

const { probeScheduledTaskExists } = await import("./schtasks-state-probe.js");

function makeResult(overrides: Partial<SpawnSyncResult> = {}): SpawnSyncResult {
  return {
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

function snapshotResult(state: unknown, extra: Record<string, unknown> = {}): SpawnSyncResult {
  return makeResult({ status: 0, stdout: JSON.stringify({ state, ...extra }) });
}

function lastProbeCall(): {
  command: string;
  args: string[];
  options: SpawnSyncOptions;
} {
  const call = spawnSync.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected a Task Scheduler probe call");
  }
  const [command, args, options] = call as unknown as [
    string,
    string[] | undefined,
    SpawnSyncOptions | undefined,
  ];
  return { command, args: args ?? [], options: options ?? {} };
}

beforeEach(() => {
  spawnSync.mockReset();
});

describe("probeScheduledTaskExists", () => {
  it("reads task state without an encoded command", () => {
    spawnSync.mockReturnValue(snapshotResult(3));

    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);

    const { command, args } = lastProbeCall();
    expect(command).toBe(getWindowsPowerShellExePath());
    expect(args).not.toContain("-EncodedCommand");
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-Command");
  });

  it("passes the task name as stdin data instead of embedding it in the command body", () => {
    const taskName = "OpenClaw Gateway & calc.exe";
    spawnSync.mockReturnValue(snapshotResult(3));

    expect(probeScheduledTaskExists(taskName)).toBe(true);

    const { args, options } = lastProbeCall();
    expect(options.input).toBe(`${Buffer.from(taskName, "utf8").toString("base64")}\n`);
    for (const arg of args) {
      expect(arg).not.toContain("calc.exe");
    }
    expect(args.join(" ")).not.toContain(taskName);
    // The body decodes the stdin payload; the raw task name must never ride in the command line.
    expect(args.join(" ")).toContain("[Console]::In.ReadLine()");
  });

  it("keeps the command body constant across task names", () => {
    spawnSync.mockReturnValue(snapshotResult(3));

    probeScheduledTaskExists("OpenClaw Gateway");
    const first = lastProbeCall();
    probeScheduledTaskExists("A completely different task");
    const second = lastProbeCall();

    expect(second.args).toEqual(first.args);
    expect(second.options.input).not.toBe(first.options.input);
  });

  it("keeps the probe bounded and hidden", () => {
    spawnSync.mockReturnValue(snapshotResult(3));

    probeScheduledTaskExists("OpenClaw Gateway");

    const { options } = lastProbeCall();
    expect(options.timeout).toBe(5_000);
    expect(options.windowsHide).toBe(true);
    expect(options.encoding).toBe("utf8");
  });

  it("honors a bounded custom timeout", () => {
    spawnSync.mockReturnValue(snapshotResult(3));

    probeScheduledTaskExists("OpenClaw Gateway", 1_200);

    expect(lastProbeCall().options.timeout).toBe(1_200);
  });

  it("caps oversized custom timeouts at five seconds", () => {
    spawnSync.mockReturnValue(snapshotResult(3));

    probeScheduledTaskExists("OpenClaw Gateway", 60_000);

    expect(lastProbeCall().options.timeout).toBe(5_000);
  });

  it("treats the locale-independent missing-task HRESULT as absent", () => {
    spawnSync.mockReturnValue(makeResult({ status: 1, stdout: "-2147024894" }));

    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(false);
  });

  it("treats the missing-folder HRESULT as absent", () => {
    spawnSync.mockReturnValue(makeResult({ status: 1, stdout: "-2147024893" }));

    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(false);
  });

  it("leaves unexpected HRESULTs unknown", () => {
    spawnSync.mockReturnValue(makeResult({ status: 1, stdout: "-2147024891" }));

    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });

  it("leaves failed COM connections unknown", () => {
    spawnSync.mockReturnValue(makeResult({ status: 2, stdout: "-2147024894" }));

    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });

  it("leaves unparseable probe output unknown", () => {
    spawnSync.mockReturnValue(makeResult({ status: 0, stdout: "not JSON" }));

    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });

  it("leaves spawn failures unknown", () => {
    spawnSync.mockReturnValue(makeResult({ status: null, error: new Error("spawnSync ENOENT") }));

    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });
});
