import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureConfigReady, __test__ } from "./config-guard.js";

const loadAndMaybeMigrateDoctorConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/doctor-config-preflight.js", () => ({
  runDoctorConfigPreflight: loadAndMaybeMigrateDoctorConfigMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

function makeSnapshot() {
  return {
    exists: false,
    valid: true,
    issues: [],
    legacyIssues: [],
    path: "/tmp/openclaw.json",
  };
}

function makeRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

async function withCapturedStdout(run: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await run();
    return writes.join("");
  } finally {
    writeSpy.mockRestore();
  }
}

describe("ensureConfigReady", () => {
  const resetConfigGuardStateForTests = __test__.resetConfigGuardStateForTests;

  async function runEnsureConfigReady(commandPath: string[], suppressDoctorStdout = false) {
    const runtime = makeRuntime();
    await ensureConfigReady({ runtime: runtime as never, commandPath, suppressDoctorStdout });
    return runtime;
  }

  function setInvalidSnapshot(overrides?: Partial<ReturnType<typeof makeSnapshot>>) {
    const snapshot = {
      ...makeSnapshot(),
      exists: true,
      valid: false,
      issues: [{ path: "channels.quietchat", message: "invalid" }],
      ...overrides,
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({
      snapshot,
      baseConfig: {},
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigGuardStateForTests();
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => ({
      snapshot: makeSnapshot(),
      baseConfig: {},
    }));
  });

  it.each([
    {
      name: "skips doctor flow for read-only fast path commands",
      commandPath: ["status"],
      expectedDoctorCalls: 0,
    },
    {
      name: "skips doctor flow for update status",
      commandPath: ["update", "status"],
      expectedDoctorCalls: 0,
    },
    {
      name: "runs doctor flow for commands that may mutate state",
      commandPath: ["message"],
      expectedDoctorCalls: 1,
    },
  ])("$name", async ({ commandPath, expectedDoctorCalls }) => {
    await runEnsureConfigReady(commandPath);
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(expectedDoctorCalls);
    if (expectedDoctorCalls > 0) {
      expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
    }
  });

  it("exits for invalid config on non-allowlisted commands", async () => {
    setInvalidSnapshot();
    const runtime = await runEnsureConfigReady(["message"]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Config invalid"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("doctor --fix"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not exit for invalid config on allowlisted commands", async () => {
    setInvalidSnapshot();
    const statusRuntime = await runEnsureConfigReady(["status"]);
    expect(statusRuntime.exit).not.toHaveBeenCalled();

    const gatewayRuntime = await runEnsureConfigReady(["gateway", "health"]);
    expect(gatewayRuntime.exit).not.toHaveBeenCalled();
  });

  it("allows an explicit invalid-config override", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    await ensureConfigReady({
      runtime: runtime as never,
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("runs doctor migration flow only once per module instance", async () => {
    const runtimeA = makeRuntime();
    const runtimeB = makeRuntime();

    await ensureConfigReady({ runtime: runtimeA as never, commandPath: ["message"] });
    await ensureConfigReady({ runtime: runtimeB as never, commandPath: ["message"] });
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });

  it("still runs doctor flow when stdout suppression is enabled", async () => {
    await runEnsureConfigReady(["message"], true);
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });

  it("prevents preflight stdout noise when suppression is enabled", async () => {
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      process.stdout.write("Doctor warnings\n");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], true);
    });
    expect(output).not.toContain("Doctor warnings");
  });

  it("allows preflight stdout noise when suppression is not enabled", async () => {
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      process.stdout.write("Doctor warnings\n");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], false);
    });
    expect(output).toContain("Doctor warnings");
  });
});
