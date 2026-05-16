import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  LAUNCH_AGENT_PROCESS_TYPE,
  LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS,
  LAUNCH_AGENT_UMASK_DECIMAL,
} from "./launchd-plist.js";
import {
  installLaunchAgent,
  disableCurrentOpenClawUpdateLaunchdJob,
  disableOpenClawUpdateLaunchdJob,
  findStaleOpenClawUpdateLaunchdJobs,
  isLaunchAgentListed,
  isOpenClawUpdateLaunchdLabel,
  parseLaunchctlPrint,
  parseLaunchctlListOpenClawUpdateJobs,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  repairLaunchAgentBootstrap,
  removeOpenClawUpdateLaunchdJob,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  stopLaunchAgent,
} from "./launchd.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  printOutput: "",
  printNotLoadedRemaining: 0,
  printError: "",
  printCode: 1,
  printFailuresRemaining: 0,
  bootstrapError: "",
  bootstrapCode: 1,
  kickstartError: "",
  kickstartCode: 1,
  kickstartFailuresRemaining: 0,
  disableError: "",
  disableCode: 1,
  stopError: "",
  stopCode: 1,
  bootoutError: "",
  bootoutCode: 1,
  serviceLoaded: true,
  serviceRunning: true,
  stopLeavesRunning: false,
  dirs: new Set<string>(),
  dirModes: new Map<string, number>(),
  files: new Map<string, string>(),
  fileModes: new Map<string, number>(),
  fileWrites: [] as Array<{ path: string; data: string }>,
}));
const launchdRestartHandoffState = vi.hoisted(() => ({
  isCurrentProcessLaunchdServiceLabel: vi.fn<(label: string) => boolean>(() => false),
  scheduleDetachedLaunchdRestartHandoff: vi.fn<
    (_params: unknown) => { ok: boolean; pid?: number; detail?: string }
  >(() => ({ ok: true, pid: 7331 })),
}));
const cleanStaleGatewayProcessesSync = vi.hoisted(() =>
  vi.fn<(port?: number) => number[]>(() => []),
);
const inspectPortUsage = vi.hoisted(() =>
  vi.fn(async () => ({ port: 18789, status: "free", listeners: [], hints: [] })),
);
const formatPortDiagnostics = vi.hoisted(() => vi.fn(() => ["Port 18789 is already in use."]));
const defaultProgramArguments = ["node", "-e", "process.exit(0)"];

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function createDefaultLaunchdEnv(): Record<string, string | undefined> {
  return {
    HOME: "/Users/test",
    OPENCLAW_PROFILE: "default",
  };
}

async function runStopLaunchAgentWithFakeTimers(args: Parameters<typeof stopLaunchAgent>[0]) {
  vi.useFakeTimers();
  try {
    const stopPromise = stopLaunchAgent(args)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    await vi.runAllTimersAsync();
    const result = await stopPromise;
    if (!result.ok) {
      throw result.error;
    }
    return;
  } finally {
    vi.useRealTimers();
  }
}

function expectLaunchctlEnableBootstrapOrder(env: Record<string, string | undefined>) {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  const label = "ai.openclaw.gateway";
  const plistPath = resolveLaunchAgentPlistPath(env);
  const serviceId = `${domain}/${label}`;
  const enableIndex = state.launchctlCalls.findIndex(
    (c) => c[0] === "enable" && c[1] === serviceId,
  );
  const bootstrapIndex = state.launchctlCalls.findIndex(
    (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
  );

  expect(enableIndex).toBeGreaterThanOrEqual(0);
  expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
  expect(enableIndex).toBeLessThan(bootstrapIndex);

  return { domain, label, serviceId, bootstrapIndex };
}

async function expectRestartLaunchAgentKickstartFailure(
  env: Record<string, string | undefined>,
): Promise<void> {
  await expect(
    restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    }),
  ).rejects.toThrow("launchctl kickstart failed: Input/output error");
}

function launchctlCommandNames(): string[] {
  return state.launchctlCalls.map(([command]) => command ?? "");
}

function normalizeLaunchctlArgs(file: string, args: string[]): string[] {
  if (file === "launchctl") {
    return args;
  }
  const idx = args.indexOf("launchctl");
  if (idx >= 0) {
    return args.slice(idx + 1);
  }
  return args;
}

vi.mock("./exec-file.js", () => ({
  execFileUtf8: vi.fn(async (file: string, args: string[]) => {
    const call = normalizeLaunchctlArgs(file, args);
    state.launchctlCalls.push(call);
    if (call[0] === "list") {
      return { stdout: state.listOutput, stderr: "", code: 0 };
    }
    if (call[0] === "print") {
      if (state.printNotLoadedRemaining > 0) {
        state.printNotLoadedRemaining -= 1;
        return { stdout: "", stderr: "Could not find service", code: 113 };
      }
      if (state.printError && state.printFailuresRemaining > 0) {
        state.printFailuresRemaining -= 1;
        return { stdout: "", stderr: state.printError, code: state.printCode };
      }
      if (!state.serviceLoaded) {
        return { stdout: "", stderr: "Could not find service", code: 113 };
      }
      if (state.printOutput) {
        return { stdout: state.printOutput, stderr: "", code: 0 };
      }
      if (!state.serviceRunning) {
        return { stdout: ["state = waiting", "pid = 0"].join("\n"), stderr: "", code: 0 };
      }
      return { stdout: ["state = running", "pid = 4242"].join("\n"), stderr: "", code: 0 };
    }
    if (call[0] === "disable" && state.disableError) {
      return { stdout: "", stderr: state.disableError, code: state.disableCode };
    }
    if (call[0] === "stop") {
      if (state.stopError) {
        return { stdout: "", stderr: state.stopError, code: state.stopCode };
      }
      if (!state.stopLeavesRunning) {
        state.serviceRunning = false;
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "bootout") {
      if (state.bootoutError) {
        return { stdout: "", stderr: state.bootoutError, code: state.bootoutCode };
      }
      state.serviceLoaded = false;
      state.serviceRunning = false;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "enable") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "bootstrap") {
      if (state.bootstrapError) {
        return { stdout: "", stderr: state.bootstrapError, code: state.bootstrapCode };
      }
      state.serviceLoaded = true;
      state.serviceRunning = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "kickstart") {
      if (state.kickstartError && state.kickstartFailuresRemaining > 0) {
        state.kickstartFailuresRemaining -= 1;
        return { stdout: "", stderr: state.kickstartError, code: state.kickstartCode };
      }
      state.serviceLoaded = true;
      state.serviceRunning = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }),
}));

vi.mock("./launchd-restart-handoff.js", () => ({
  isCurrentProcessLaunchdServiceLabel: (label: string) =>
    launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel(label),
  scheduleDetachedLaunchdRestartHandoff: (params: unknown) =>
    launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff(params),
}));

vi.mock("../infra/restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (port?: number) => cleanStaleGatewayProcessesSync(port),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage,
  formatPortDiagnostics,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const wrapped = {
    ...actual,
    access: vi.fn(async (p: string) => {
      const key = p;
      if (state.files.has(key) || state.dirs.has(key)) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory, access '${key}'`);
    }),
    mkdir: vi.fn(async (p: string, opts?: { mode?: number }) => {
      const key = p;
      state.dirs.add(key);
      state.dirModes.set(key, opts?.mode ?? 0o777);
    }),
    stat: vi.fn(async (p: string) => {
      const key = p;
      if (state.dirs.has(key)) {
        return { mode: state.dirModes.get(key) ?? 0o777 };
      }
      if (state.files.has(key)) {
        return { mode: state.fileModes.get(key) ?? 0o666 };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${key}'`);
    }),
    chmod: vi.fn(async (p: string, mode: number) => {
      const key = p;
      if (state.dirs.has(key)) {
        state.dirModes.set(key, mode);
        return;
      }
      if (state.files.has(key)) {
        state.fileModes.set(key, mode);
        return;
      }
      throw new Error(`ENOENT: no such file or directory, chmod '${key}'`);
    }),
    readFile: vi.fn(async (p: string) => {
      const key = p;
      const data = state.files.get(key);
      if (data !== undefined) {
        return data;
      }
      throw new Error(`ENOENT: no such file or directory, open '${key}'`);
    }),
    unlink: vi.fn(async (p: string) => {
      state.files.delete(p);
    }),
    writeFile: vi.fn(async (p: string, data: string, opts?: { mode?: number }) => {
      const key = p;
      state.files.set(key, data);
      state.fileWrites.push({ path: key, data });
      state.dirs.add(key.split("/").slice(0, -1).join("/"));
      state.fileModes.set(key, opts?.mode ?? 0o666);
    }),
  };
  return { ...wrapped, default: wrapped };
});

beforeEach(() => {
  state.launchctlCalls.length = 0;
  state.listOutput = "";
  state.printOutput = "";
  state.printNotLoadedRemaining = 0;
  state.printError = "";
  state.printCode = 1;
  state.printFailuresRemaining = 0;
  state.bootstrapError = "";
  state.bootstrapCode = 1;
  state.kickstartError = "";
  state.kickstartCode = 1;
  state.kickstartFailuresRemaining = 0;
  state.disableError = "";
  state.disableCode = 1;
  state.stopError = "";
  state.stopCode = 1;
  state.bootoutError = "";
  state.bootoutCode = 1;
  state.serviceLoaded = true;
  state.serviceRunning = true;
  state.stopLeavesRunning = false;
  state.dirs.clear();
  state.dirModes.clear();
  state.files.clear();
  state.fileModes.clear();
  state.fileWrites.length = 0;
  cleanStaleGatewayProcessesSync.mockReset();
  cleanStaleGatewayProcessesSync.mockReturnValue([]);
  inspectPortUsage.mockReset();
  inspectPortUsage.mockResolvedValue({ port: 18789, status: "free", listeners: [], hints: [] });
  formatPortDiagnostics.mockReset();
  formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
  launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReset();
  launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReturnValue(false);
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReset();
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReturnValue({
    ok: true,
    pid: 7331,
  });
  vi.clearAllMocks();
});

describe("launchd runtime parsing", () => {
  it("parses state, pid, and exit status", () => {
    const output = [
      "state = running",
      "pid = 4242",
      "last exit status = 1",
      "last exit reason = exited",
    ].join("\n");
    expect(parseLaunchctlPrint(output)).toEqual({
      state: "running",
      pid: 4242,
      lastExitStatus: 1,
      lastExitReason: "exited",
    });
  });

  it("does not set pid when pid = 0", () => {
    const output = ["state = running", "pid = 0"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBeUndefined();
    expect(info.state).toBe("running");
  });

  it("sets pid for positive values", () => {
    const output = ["state = running", "pid = 1234"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBe(1234);
  });

  it("does not set pid for negative values", () => {
    const output = ["state = waiting", "pid = -1"].join("\n");
    const info = parseLaunchctlPrint(output);
    expect(info.pid).toBeUndefined();
    expect(info.state).toBe("waiting");
  });

  it("rejects pid and exit status values with junk suffixes", () => {
    const output = [
      "state = waiting",
      "pid = 123abc",
      "last exit status = 7ms",
      "last exit reason = exited",
    ].join("\n");
    expect(parseLaunchctlPrint(output)).toEqual({
      state: "waiting",
      lastExitReason: "exited",
    });
  });
});

describe("launchd runtime state", () => {
  it("marks installed plist split-brain when launchd no longer has the job", async () => {
    const env = createDefaultLaunchdEnv();
    state.files.set(resolveLaunchAgentPlistPath(env), "<plist/>");
    state.serviceLoaded = false;

    const runtime = await readLaunchAgentRuntime(env);
    expect(runtime.status).toBe("unknown");
    expect(runtime.missingSupervision).toBe(true);
    expect(runtime.detail).toBe("Could not find service");
  });

  it("marks a missing unit when launchd has no job and no plist exists", async () => {
    const env = createDefaultLaunchdEnv();
    state.serviceLoaded = false;

    const runtime = await readLaunchAgentRuntime(env);
    expect(runtime.status).toBe("unknown");
    expect(runtime.missingUnit).toBe(true);
  });
});

describe("launchctl list detection", () => {
  it("detects the resolved label in launchctl list", async () => {
    state.listOutput = "123 0 ai.openclaw.gateway\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    });
    expect(listed).toBe(true);
  });

  it("returns false when the label is missing", async () => {
    state.listOutput = "123 0 com.other.service\n";
    const listed = await isLaunchAgentListed({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    });
    expect(listed).toBe(false);
  });

  it("parses stale OpenClaw updater jobs from launchctl list", () => {
    const jobs = parseLaunchctlListOpenClawUpdateJobs(
      [
        "123 0 ai.openclaw.gateway",
        "- 127 ai.openclaw.update.2026.5.12",
        "8142 0 ai.openclaw.update.2026.5.13-beta.1",
        "- 0 com.example.other",
      ].join("\n"),
    );

    expect(jobs).toEqual([
      {
        label: "ai.openclaw.update.2026.5.12",
        lastExitStatus: 127,
      },
      {
        label: "ai.openclaw.update.2026.5.13-beta.1",
        pid: 8142,
        lastExitStatus: 0,
      },
    ]);
  });

  it.runIf(process.platform === "darwin")(
    "finds stale OpenClaw updater jobs via launchctl list",
    async () => {
      state.listOutput = "- 127 ai.openclaw.update.2026.5.12\n";

      const jobs = await findStaleOpenClawUpdateLaunchdJobs();

      expect(jobs).toEqual([
        {
          label: "ai.openclaw.update.2026.5.12",
          lastExitStatus: 127,
        },
      ]);
    },
  );

  it("recognizes only legacy OpenClaw update launchd labels", () => {
    expect(isOpenClawUpdateLaunchdLabel("ai.openclaw.update.2026.5.12")).toBe(true);
    expect(isOpenClawUpdateLaunchdLabel("ai.openclaw.gateway")).toBe(false);
    expect(isOpenClawUpdateLaunchdLabel("com.example.update")).toBe(false);
  });

  it.runIf(process.platform === "darwin")("removes legacy updater launchd jobs", async () => {
    await expect(removeOpenClawUpdateLaunchdJob(" ai.openclaw.update.2026.5.12 ")).resolves.toBe(
      true,
    );

    expect(state.launchctlCalls).toContainEqual(["remove", "ai.openclaw.update.2026.5.12"]);
  });

  it.runIf(process.platform === "darwin")(
    "disables the current legacy updater launchd job",
    async () => {
      await expect(
        disableCurrentOpenClawUpdateLaunchdJob({
          LAUNCH_JOB_LABEL: "ai.openclaw.update.2026.5.12",
        }),
      ).resolves.toBe(true);

      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      expect(state.launchctlCalls).toContainEqual([
        "disable",
        `${domain}/ai.openclaw.update.2026.5.12`,
      ]);
      expect(launchctlCommandNames()).not.toContain("remove");
    },
  );

  it.runIf(process.platform === "darwin")(
    "disables the current legacy updater launchd job from OpenClaw label env",
    async () => {
      await expect(
        disableCurrentOpenClawUpdateLaunchdJob({
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.update.2026.5.12",
        }),
      ).resolves.toBe(true);

      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      expect(state.launchctlCalls).toContainEqual([
        "disable",
        `${domain}/ai.openclaw.update.2026.5.12`,
      ]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "does not let non-update launchd markers mask the OpenClaw update label",
    async () => {
      await expect(
        disableCurrentOpenClawUpdateLaunchdJob({
          XPC_SERVICE_NAME: "0",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.update.2026.5.12",
        }),
      ).resolves.toBe(true);

      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      expect(state.launchctlCalls).toContainEqual([
        "disable",
        `${domain}/ai.openclaw.update.2026.5.12`,
      ]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "does not disable the current gateway launchd job",
    async () => {
      await expect(
        disableCurrentOpenClawUpdateLaunchdJob({
          LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
        }),
      ).resolves.toBe(false);

      expect(state.launchctlCalls).toEqual([]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "does not disable profile-specific gateway launchd jobs that look like updater labels",
    async () => {
      await expect(
        disableCurrentOpenClawUpdateLaunchdJob({
          LAUNCH_JOB_LABEL: "ai.openclaw.update.2026.5.12",
          OPENCLAW_PROFILE: "update.2026.5.12",
        }),
      ).resolves.toBe(false);

      expect(state.launchctlCalls).toEqual([]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "does not disable custom gateway launchd labels that look like updater labels",
    async () => {
      await expect(
        disableCurrentOpenClawUpdateLaunchdJob({
          LAUNCH_JOB_LABEL: "ai.openclaw.update.2026.5.12",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.update.2026.5.12",
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        }),
      ).resolves.toBe(false);

      expect(state.launchctlCalls).toEqual([]);
    },
  );

  it.runIf(process.platform === "darwin")("disables explicit legacy updater jobs", async () => {
    await expect(disableOpenClawUpdateLaunchdJob("ai.openclaw.update.2026.5.12")).resolves.toBe(
      true,
    );

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    expect(state.launchctlCalls).toContainEqual([
      "disable",
      `${domain}/ai.openclaw.update.2026.5.12`,
    ]);
  });
});

describe("launchd bootstrap repair", () => {
  it("enables and bootstraps the resolved label without kickstarting the fresh agent", async () => {
    const env = createDefaultLaunchdEnv();
    const repair = await repairLaunchAgentBootstrap({ env });
    expect(repair).toEqual({ ok: true, status: "repaired" });

    expectLaunchctlEnableBootstrapOrder(env);
    expect(launchctlCommandNames()).not.toContain("kickstart");
  });

  it("treats bootstrap exit 130 as success and nudges the already-loaded service when stopped", async () => {
    state.bootstrapError = "Service already loaded";
    state.bootstrapCode = 130;
    state.serviceRunning = false;
    const env = createDefaultLaunchdEnv();

    const repair = await repairLaunchAgentBootstrap({ env });

    const { serviceId } = expectLaunchctlEnableBootstrapOrder(env);
    expect(repair).toEqual({ ok: true, status: "already-loaded" });
    expect(state.launchctlCalls.find((call) => call[0] === "kickstart")).toEqual([
      "kickstart",
      serviceId,
    ]);
    expect(countMatching(state.launchctlCalls, (call) => call[0] === "kickstart")).toBe(1);
  });

  it("skips kickstart when already-loaded service is actively running", async () => {
    state.bootstrapError = "Service already loaded";
    state.bootstrapCode = 130;
    const env = createDefaultLaunchdEnv();

    const repair = await repairLaunchAgentBootstrap({ env });

    expect(repair).toEqual({ ok: true, status: "already-loaded" });
    expect(launchctlCommandNames()).not.toContain("kickstart");
  });

  it("treats 'already exists in domain' bootstrap failures as success and nudges the service when stopped", async () => {
    state.bootstrapError =
      "Could not bootstrap service: 5: Input/output error: already exists in domain for gui/501";
    state.serviceRunning = false;
    const env = createDefaultLaunchdEnv();

    const repair = await repairLaunchAgentBootstrap({ env });

    const { serviceId } = expectLaunchctlEnableBootstrapOrder(env);
    expect(repair).toEqual({ ok: true, status: "already-loaded" });
    expect(state.launchctlCalls.find((call) => call[0] === "kickstart")).toEqual([
      "kickstart",
      serviceId,
    ]);
    expect(countMatching(state.launchctlCalls, (call) => call[0] === "kickstart")).toBe(1);
  });

  it("keeps genuine bootstrap failures as failures", async () => {
    state.bootstrapError = "Could not find specified service";
    const env = createDefaultLaunchdEnv();

    const repair = await repairLaunchAgentBootstrap({ env });

    expect(repair.ok).toBe(false);
    if (repair.ok) {
      throw new Error("expected bootstrap repair to fail");
    }
    expect(repair.status).toBe("bootstrap-failed");
    expect(repair.detail).toContain("Could not find specified service");
    expect(launchctlCommandNames()).not.toContain("kickstart");
  });

  it("returns a typed kickstart failure when already-loaded recovery cannot nudge the service", async () => {
    state.bootstrapError = "Service already loaded";
    state.bootstrapCode = 130;
    state.serviceRunning = false;
    state.kickstartError = "launchctl kickstart failed: permission denied";
    state.kickstartFailuresRemaining = 1;
    const env = createDefaultLaunchdEnv();

    const repair = await repairLaunchAgentBootstrap({ env });

    expect(repair).toEqual({
      ok: false,
      status: "kickstart-failed",
      detail: "launchctl kickstart failed: permission denied",
    });
  });
});

describe("launchd install", () => {
  it("enables service before bootstrap without self-restarting the fresh agent", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const { serviceId } = expectLaunchctlEnableBootstrapOrder(env);
    const installKickstartIndex = state.launchctlCalls.findIndex(
      (c) => c[0] === "kickstart" && c[2] === serviceId,
    );
    expect(installKickstartIndex).toBe(-1);
  });

  it("writes LaunchAgent environment to an owner-only env file when provided", async () => {
    const env = createDefaultLaunchdEnv();
    const tmpDir = "/Users/test/.openclaw/tmp";
    const apiKey = "secret-api-key";
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
      environment: { TMPDIR: tmpDir, OPENAI_API_KEY: apiKey },
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    const envFilePath = "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env";
    const wrapperPath = "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh";
    const plist = state.files.get(plistPath) ?? "";
    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
    expect(plist).not.toContain(apiKey);
    expect(plist).toContain(`<string>${wrapperPath}</string>`);
    expect(plist).toContain(`<string>${envFilePath}</string>`);
    const envFile = state.files.get(envFilePath) ?? "";
    expect(envFile).toContain(`export TMPDIR='${tmpDir}'`);
    expect(envFile).toContain(`export OPENAI_API_KEY='${apiKey}'`);
    expect(state.fileModes.get(envFilePath)).toBe(0o600);
    expect(state.fileModes.get(wrapperPath)).toBe(0o700);
    expect(state.dirModes.get("/Users/test/.openclaw/service-env")).toBe(0o700);

    const command = await readLaunchAgentProgramArguments(env);
    expect(command?.programArguments).toEqual(defaultProgramArguments);
    expect(command?.environment?.TMPDIR).toBe(tmpDir);
    expect(command?.environment?.OPENAI_API_KEY).toBe(apiKey);
    expect(command?.environmentValueSources?.TMPDIR).toBe("file");
    expect(command?.environmentValueSources?.OPENAI_API_KEY).toBe("file");
  });

  it("creates the LaunchAgent TMPDIR before bootstrap", async () => {
    const env = createDefaultLaunchdEnv();
    const tmpDir = "/Users/test/.openclaw/tmp";
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
      environment: { TMPDIR: tmpDir },
    });

    expect(state.dirs.has(tmpDir)).toBe(true);
    expect(state.dirModes.get(tmpDir)).toBe(0o700);
  });

  it("writes KeepAlive=true policy with shutdown and throttle limits", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    const plist = state.files.get(plistPath) ?? "";
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).not.toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<key>ExitTimeOut</key>");
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>`);
    expect(plist).toContain("<key>ProcessType</key>");
    expect(plist).toContain(`<string>${LAUNCH_AGENT_PROCESS_TYPE}</string>`);
    expect(plist).toContain("<key>Umask</key>");
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>`);
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>`);
  });

  it("rewrites the plist before bootstrap during restart fallback", async () => {
    const env = createDefaultLaunchdEnv();
    const plistPath = resolveLaunchAgentPlistPath(env);
    state.serviceLoaded = false;
    state.kickstartError = "Could not find service";
    state.kickstartFailuresRemaining = 1;
    state.files.set(
      plistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        "  <dict>",
        "    <key>Label</key>",
        "    <string>ai.openclaw.gateway</string>",
        "    <key>ProgramArguments</key>",
        "    <array>",
        "      <string>node</string>",
        "      <string>gateway.js</string>",
        "    </array>",
        "  </dict>",
        "</plist>",
      ].join("\n"),
    );

    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const plist = state.files.get(plistPath) ?? "";
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("<string>/dev/null</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>node</string>");
    const rewriteIndex = state.fileWrites.findIndex((write) => write.path === plistPath);
    const bootstrapIndex = state.launchctlCalls.findIndex((call) => call[0] === "bootstrap");
    expect(rewriteIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(rewriteIndex).toBeLessThan(bootstrapIndex);
  });

  it("tightens writable bits on launch agent dirs and plist", async () => {
    const env = createDefaultLaunchdEnv();
    state.dirs.add(env.HOME!);
    state.dirModes.set(env.HOME!, 0o777);
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o777);

    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
    });

    const plistPath = resolveLaunchAgentPlistPath(env);
    expect(state.dirModes.get(env.HOME!)).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library")).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library/LaunchAgents")).toBe(0o755);
    expect(state.fileModes.get(plistPath)).toBe(0o600);
  });

  it("stops LaunchAgent via bootout by default, preserving KeepAlive for future crashes", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const serviceId = `${domain}/ai.openclaw.gateway`;
    expect(state.launchctlCalls).toEqual([["bootout", serviceId]]);
    expect(output).toContain("Stopped LaunchAgent");
  });

  it("verifies the configured gateway port is released before reporting stop success", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "19003",
    };
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout });

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19003);
    expect(inspectPortUsage).toHaveBeenCalledWith(19003);
    expect(output).toContain("Stopped LaunchAgent");
  });

  it("resolves the stop postcondition port from the stored LaunchAgent environment", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
      environment: { OPENCLAW_GATEWAY_PORT: "19006" },
    });
    state.launchctlCalls.length = 0;

    await stopLaunchAgent({ env, stdout: new PassThrough() });

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19006);
    expect(inspectPortUsage).toHaveBeenCalledWith(19006);
  });

  it("fails stop when the verified gateway port remains busy after cleanup", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "19004",
    };
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    inspectPortUsage.mockResolvedValue({
      port: 19004,
      status: "busy",
      listeners: [],
      hints: [],
    });
    formatPortDiagnostics.mockReturnValue(["Port 19004 is held by pid 4242."]);

    await expect(stopLaunchAgent({ env, stdout })).rejects.toThrow(
      "gateway port 19004 is still busy after LaunchAgent stop\nPort 19004 is held by pid 4242.",
    );

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19004);
    expect(inspectPortUsage).toHaveBeenCalledWith(19004);
    expect(output).not.toContain("Stopped LaunchAgent");
  });

  it("stops LaunchAgent with disable+stop when --disable is passed", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout, disable: true });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const serviceId = `${domain}/ai.openclaw.gateway`;
    expect(state.launchctlCalls).toEqual([
      ["disable", serviceId],
      ["stop", "ai.openclaw.gateway"],
      ["print", serviceId],
    ]);
    expect(output).toContain("Stopped LaunchAgent");
  });

  it("verifies the configured gateway port is released before reporting disable stop success", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "19005",
    };
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout, disable: true });

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19005);
    expect(inspectPortUsage).toHaveBeenCalledWith(19005);
    expect(output).toContain("Stopped LaunchAgent");
  });

  it("treats already-unloaded services as successfully stopped without bootout fallback (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.serviceLoaded = false;
    state.serviceRunning = false;
    state.stopError = "Could not find service";
    state.stopCode = 113;
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout, disable: true });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const serviceId = `${domain}/ai.openclaw.gateway`;
    expect(state.launchctlCalls).toEqual([
      ["disable", serviceId],
      ["stop", "ai.openclaw.gateway"],
      ["print", serviceId],
    ]);
    expect(launchctlCommandNames()).not.toContain("bootout");
    expect(output).toContain("Stopped LaunchAgent");
    expect(output).not.toContain("degraded");
  });

  it("treats already-unloaded services as successfully stopped in default bootout path", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.serviceLoaded = false;
    state.serviceRunning = false;
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout });

    expect(launchctlCommandNames()).not.toContain("disable");
    expect(output).toContain("Stopped LaunchAgent");
    expect(output).not.toContain("degraded");
  });

  it("falls back to bootout when disable fails so stop remains authoritative (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.disableError = "Operation not permitted";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout, disable: true });

    expect(launchctlCommandNames()).not.toContain("stop");
    expect(launchctlCommandNames()).toContain("bootout");
    expect(output).toContain("Stopped LaunchAgent (degraded)");
    expect(output).toContain("used bootout fallback");
  });

  it("does not report degraded stop success when fallback cleanup leaves the port busy", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "19008",
    };
    const stdout = new PassThrough();
    let output = "";
    state.disableError = "Operation not permitted";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    inspectPortUsage.mockResolvedValue({
      port: 19008,
      status: "busy",
      listeners: [],
      hints: [],
    });
    formatPortDiagnostics.mockReturnValue(["Port 19008 is held by pid 4242."]);

    await expect(stopLaunchAgent({ env, stdout, disable: true })).rejects.toThrow(
      "gateway port 19008 is still busy after LaunchAgent stop\nPort 19008 is held by pid 4242.",
    );

    expect(launchctlCommandNames()).toContain("bootout");
    expect(output).toContain("used bootout fallback");
    expect(output).not.toContain("Stopped LaunchAgent");
  });

  it("falls back to bootout when stop does not fully stop the service (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.stopLeavesRunning = true;
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await runStopLaunchAgentWithFakeTimers({ env, stdout, disable: true });

    expect(launchctlCommandNames()).toContain("stop");
    expect(launchctlCommandNames()).toContain("bootout");
    expect(output).toContain("Stopped LaunchAgent (degraded)");
    expect(output).toContain("did not fully stop the service");
  });

  it("treats launchctl print state=running as running even when pid is missing (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.stopLeavesRunning = true;
    state.printOutput = "state = running\n";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await runStopLaunchAgentWithFakeTimers({ env, stdout, disable: true });

    expect(launchctlCommandNames()).toContain("bootout");
    expect(output).toContain("Stopped LaunchAgent (degraded)");
    expect(output).toContain("did not fully stop the service");
  });

  it("falls back to bootout when launchctl stop itself errors (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.stopError = "stop failed due to transient launchd error";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout, disable: true });

    expect(launchctlCommandNames()).toContain("bootout");
    expect(output).toContain("Stopped LaunchAgent (degraded)");
    expect(output).toContain("launchctl stop failed; used bootout fallback");
  });

  it("falls back to bootout when launchctl print cannot confirm the stop state (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.printError = "launchctl print permission denied";
    state.printFailuresRemaining = 10;
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await runStopLaunchAgentWithFakeTimers({ env, stdout, disable: true });

    expect(launchctlCommandNames()).toContain("bootout");
    expect(output).toContain("Stopped LaunchAgent (degraded)");
    expect(output).toContain("could not confirm stop");
  });

  it("throws when launchctl print cannot confirm stop and bootout also fails (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    state.printError = "launchctl print permission denied";
    state.printFailuresRemaining = 10;
    state.bootoutError = "launchctl bootout permission denied";

    await expect(
      runStopLaunchAgentWithFakeTimers({ env, stdout: new PassThrough(), disable: true }),
    ).rejects.toThrow(
      "launchctl print could not confirm stop; used bootout fallback and left service unloaded: launchctl print permission denied; launchctl bootout failed: launchctl bootout permission denied",
    );
  });

  it("throws when default bootout fails", async () => {
    const env = createDefaultLaunchdEnv();
    state.bootoutError = "launchctl bootout permission denied";
    state.bootoutCode = 1;

    await expect(stopLaunchAgent({ env, stdout: new PassThrough() })).rejects.toThrow(
      "launchctl bootout failed: launchctl bootout permission denied",
    );
    expect(launchctlCommandNames()).not.toContain("disable");
    expect(launchctlCommandNames()).not.toContain("stop");
  });

  it("sanitizes launchctl details before writing warnings (--disable)", async () => {
    const env = createDefaultLaunchdEnv();
    const stdout = new PassThrough();
    let output = "";
    state.disableError = "boom\n\u001b[31mred\u001b[0m\tmsg";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await stopLaunchAgent({ env, stdout, disable: true });

    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("\nred\n");
    expect(output).toContain("boom red msg");
  });

  it("restarts LaunchAgent with kickstart and no bootout", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "18789",
    };
    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const label = "ai.openclaw.gateway";
    const serviceId = `${domain}/${label}`;
    expect(result).toEqual({ outcome: "completed" });
    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(18789);
    expect(state.launchctlCalls).toEqual([
      ["enable", serviceId],
      ["kickstart", "-k", serviceId],
    ]);
    expect(launchctlCommandNames()).not.toContain("bootout");
    expect(launchctlCommandNames()).not.toContain("bootstrap");
  });

  it("uses the configured gateway port for stale cleanup", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "19001",
    };

    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19001);
  });

  it("uses the stored LaunchAgent environment port for restart stale cleanup", async () => {
    const env = createDefaultLaunchdEnv();
    await installLaunchAgent({
      env,
      stdout: new PassThrough(),
      programArguments: defaultProgramArguments,
      environment: { OPENCLAW_GATEWAY_PORT: "19007" },
    });
    state.launchctlCalls.length = 0;

    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19007);
    expect(inspectPortUsage).toHaveBeenCalledWith(19007);
  });

  it("fails restart before kickstart when the configured gateway port remains busy", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_GATEWAY_PORT: "19002",
    };
    inspectPortUsage.mockResolvedValue({
      port: 19002,
      status: "busy",
      listeners: [],
      hints: [],
    });
    formatPortDiagnostics.mockReturnValue(["Port 19002 is held by pid 4242."]);

    await expect(
      restartLaunchAgent({
        env,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow(
      "gateway port 19002 is still busy before LaunchAgent restart\nPort 19002 is held by pid 4242.",
    );

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19002);
    expect(inspectPortUsage).toHaveBeenCalledWith(19002);
    expect(launchctlCommandNames()).not.toContain("kickstart");
  });

  it("skips stale cleanup when no explicit launch agent port can be resolved", async () => {
    const env = createDefaultLaunchdEnv();
    state.files.clear();

    await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
  });

  it("falls back to bootstrap when kickstart cannot find the service", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Could not find service";
    state.kickstartFailuresRemaining = 1;

    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    const serviceId = `${domain}/ai.openclaw.gateway`;
    const kickstartCalls = state.launchctlCalls.filter(
      (c) => c[0] === "kickstart" && c[1] === "-k" && c[2] === serviceId,
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(launchctlCommandNames()).toContain("enable");
    expect(launchctlCommandNames()).toContain("bootstrap");
    expect(kickstartCalls).toHaveLength(1);
    expect(launchctlCommandNames()).not.toContain("bootout");
  });

  it("surfaces the original kickstart failure when the service is still loaded", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Input/output error";
    state.kickstartFailuresRemaining = 1;

    await expectRestartLaunchAgentKickstartFailure(env);

    expect(launchctlCommandNames()).toContain("enable");
    expect(launchctlCommandNames()).not.toContain("bootstrap");
  });

  it("re-bootstraps when kickstart failure leaves the service unloaded (#52208)", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Input/output error";
    state.kickstartFailuresRemaining = 1;
    state.printNotLoadedRemaining = 1;

    await expectRestartLaunchAgentKickstartFailure(env);

    expect(launchctlCommandNames()).toContain("enable");
    expect(launchctlCommandNames()).toContain("bootstrap");
  });

  it("skips re-bootstrap when kickstart fails but service is still loaded (#52208)", async () => {
    const env = createDefaultLaunchdEnv();
    state.kickstartError = "Input/output error";
    state.kickstartFailuresRemaining = 1;

    await expectRestartLaunchAgentKickstartFailure(env);

    expect(launchctlCommandNames()).toContain("enable");
    expect(launchctlCommandNames()).not.toContain("bootstrap");
  });

  it("hands restart off to a detached helper when invoked from the current LaunchAgent", async () => {
    const env = createDefaultLaunchdEnv();
    launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReturnValue(true);

    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
    });

    expect(result).toEqual({ outcome: "scheduled" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).toHaveBeenCalledWith({
      env,
      mode: "kickstart",
      waitForPid: process.pid,
    });
    expect(state.launchctlCalls).toStrictEqual([]);
  });

  it("surfaces detached handoff failures", async () => {
    const env = createDefaultLaunchdEnv();
    launchdRestartHandoffState.isCurrentProcessLaunchdServiceLabel.mockReturnValue(true);
    launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReturnValue({
      ok: false,
      detail: "spawn failed",
    });

    await expect(
      restartLaunchAgent({
        env,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("launchd restart handoff failed: spawn failed");
  });

  it("shows actionable guidance when launchctl gui domain does not support bootstrap", async () => {
    state.bootstrapError = "Bootstrap failed: 125: Domain does not support specified action";
    const env = createDefaultLaunchdEnv();
    let message = "";
    try {
      await installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("logged-in macOS GUI session");
    expect(message).toContain("wrong user (including sudo)");
    expect(message).toContain("https://docs.openclaw.ai/gateway");
  });

  it("surfaces generic bootstrap failures without GUI-specific guidance", async () => {
    state.bootstrapError = "Operation not permitted";
    const env = createDefaultLaunchdEnv();

    await expect(
      installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toThrow("launchctl bootstrap failed: Operation not permitted");
  });
});

describe("resolveLaunchAgentPlistPath", () => {
  it.each([
    {
      name: "uses default label when OPENCLAW_PROFILE is unset",
      env: { HOME: "/Users/test" },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
    },
    {
      name: "uses profile-specific label when OPENCLAW_PROFILE is set to a custom value",
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.jbphoenix.plist",
    },
    {
      name: "prefers OPENCLAW_LAUNCHD_LABEL over OPENCLAW_PROFILE",
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "jbphoenix",
        OPENCLAW_LAUNCHD_LABEL: "com.custom.label",
      },
      expected: "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    },
    {
      name: "trims whitespace from OPENCLAW_LAUNCHD_LABEL",
      env: {
        HOME: "/Users/test",
        OPENCLAW_LAUNCHD_LABEL: "  com.custom.label  ",
      },
      expected: "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    },
    {
      name: "ignores empty OPENCLAW_LAUNCHD_LABEL and falls back to profile",
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "myprofile",
        OPENCLAW_LAUNCHD_LABEL: "   ",
      },
      expected: "/Users/test/Library/LaunchAgents/ai.openclaw.myprofile.plist",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveLaunchAgentPlistPath(env)).toBe(expected);
  });

  it("rejects invalid launchd labels that contain path separators", () => {
    expect(() =>
      resolveLaunchAgentPlistPath({
        HOME: "/Users/test",
        OPENCLAW_LAUNCHD_LABEL: "../evil/label",
      }),
    ).toThrow("Invalid launchd label");
  });
});
