import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { registerDaemonCli } from "./daemon-cli/register.js";

const probeGatewayStatus = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const resolveGatewayProgramArguments = vi.fn(async (_opts?: unknown) => ({
  programArguments: ["/bin/node", "cli", "gateway", "--port", "18789"],
}));
const serviceInstall = vi.fn().mockResolvedValue(undefined);
const serviceStage = vi.fn().mockResolvedValue(undefined);
const serviceUninstall = vi.fn().mockResolvedValue(undefined);
const serviceStop = vi.fn().mockResolvedValue(undefined);
const serviceRestart = vi.fn().mockResolvedValue({ outcome: "completed" });
const serviceIsLoaded = vi.fn().mockResolvedValue(false);
const serviceReadCommand = vi.fn().mockResolvedValue(null);
const serviceReadRuntime = vi.fn().mockResolvedValue({ status: "running" });
const resolveGatewayProbeAuthSafeWithSecretInputs = vi.fn(async (_opts?: unknown) => ({
  auth: {},
}));
const findExtraGatewayServices = vi.fn(async (_env: unknown, _opts?: unknown) => []);
const inspectPortUsage = vi.fn(async (port: number) => ({
  port,
  status: "free",
  listeners: [],
  hints: [],
}));
const buildGatewayInstallPlan = vi.fn(
  async (params: {
    port: number;
    token?: string;
    env?: NodeJS.ProcessEnv;
    wrapperPath?: string;
    existingEnvironment?: Record<string, string>;
  }) => ({
    programArguments: ["/bin/node", "cli", "gateway", "--port", String(params.port)],
    workingDirectory: process.cwd(),
    environment: {
      OPENCLAW_GATEWAY_PORT: String(params.port),
      ...(params.wrapperPath ? { OPENCLAW_WRAPPER: params.wrapperPath } : {}),
      ...(params.token ? { OPENCLAW_GATEWAY_TOKEN: params.token } : {}),
    },
  }),
);

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi);
});

const { runtimeLogs } = mocks;

vi.mock("./daemon-cli/probe.js", () => ({
  probeGatewayStatus: (opts: unknown) => probeGatewayStatus(opts),
}));

vi.mock("../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafeWithSecretInputs: (opts: unknown) =>
    resolveGatewayProbeAuthSafeWithSecretInputs(opts),
}));

vi.mock("../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveGatewayProgramArguments: (opts: unknown) => resolveGatewayProgramArguments(opts),
  resolveOpenClawWrapperPath: async (value: string | undefined) => value?.trim() || undefined,
}));

vi.mock("../daemon/service.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js");
  return {
    ...actual,
    resolveGatewayService: () => ({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: serviceStage,
      install: serviceInstall,
      uninstall: serviceUninstall,
      stop: serviceStop,
      restart: serviceRestart,
      isLoaded: serviceIsLoaded,
      readCommand: serviceReadCommand,
      readRuntime: serviceReadRuntime,
    }),
  };
});

vi.mock("../daemon/legacy.js", () => ({
  findLegacyGatewayServices: async () => [],
}));

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices: (env: unknown, opts?: unknown) => findExtraGatewayServices(env, opts),
  renderGatewayServiceCleanupHints: () => [],
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
  formatPortDiagnostics: () => ["Port 18789 is already in use."],
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: (params: {
    port: number;
    token?: string;
    env?: NodeJS.ProcessEnv;
    wrapperPath?: string;
    existingEnvironment?: Record<string, string>;
  }) => buildGatewayInstallPlan(params),
}));

vi.mock("./deps.js", () => ({
  createDefaultDeps: () => {},
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

let daemonProgram: Command;

function createDaemonProgram() {
  const program = new Command();
  program.exitOverride();
  registerDaemonCli(program);
  return program;
}

async function runDaemonCommand(args: string[]) {
  await daemonProgram.parseAsync(args, { from: "user" });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe logged JSON shape.
function parseFirstJsonRuntimeLine<T>() {
  const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as T;
}

describe("daemon-cli coverage", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tmpDir: string;

  beforeEach(() => {
    daemonProgram = createDaemonProgram();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-cli-"));
    envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_PROFILE",
    ]);
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    process.env.OPENCLAW_CONFIG_PATH = path.join(tmpDir, "openclaw.json");
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_PROFILE;
    serviceReadCommand.mockResolvedValue(null);
    resolveGatewayProbeAuthSafeWithSecretInputs.mockClear();
    findExtraGatewayServices.mockClear();
    buildGatewayInstallPlan.mockClear();
  });

  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("probes gateway status by default", async () => {
    runtimeLogs.length = 0;
    probeGatewayStatus.mockClear();

    await runDaemonCommand(["daemon", "status"]);

    expect(probeGatewayStatus).toHaveBeenCalledTimes(1);
    expect(probeGatewayStatus).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(findExtraGatewayServices).not.toHaveBeenCalled();
    expect(inspectPortUsage).toHaveBeenCalled();
  });

  it("derives probe URL from service args + env (json)", async () => {
    runtimeLogs.length = 0;
    probeGatewayStatus.mockClear();
    inspectPortUsage.mockClear();

    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
      environment: {
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon-state",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon-state/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "19001",
      },
      sourcePath: "/tmp/ai.openclaw.gateway.plist",
    });

    await runDaemonCommand(["daemon", "status", "--json"]);

    expect(probeGatewayStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:19001",
      }),
    );
    expect(inspectPortUsage).toHaveBeenCalledWith(19001);

    const parsed = parseFirstJsonRuntimeLine<{
      gateway?: { port?: number; portSource?: string; probeUrl?: string };
      config?: { mismatch?: boolean };
      rpc?: { url?: string; ok?: boolean };
    }>();
    expect(parsed.gateway?.port).toBe(19001);
    expect(parsed.gateway?.portSource).toBe("service args");
    expect(parsed.gateway?.probeUrl).toBe("ws://127.0.0.1:19001");
    expect(parsed.config?.mismatch).toBe(true);
    expect(parsed.rpc?.url).toBe("ws://127.0.0.1:19001");
    expect(parsed.rpc?.ok).toBe(true);
  });

  it("passes deep scan flag for daemon status", async () => {
    findExtraGatewayServices.mockClear();

    await runDaemonCommand(["daemon", "status", "--deep"]);

    expect(findExtraGatewayServices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deep: true }),
    );
  });

  it("installs the daemon (json output)", async () => {
    runtimeLogs.length = 0;
    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceInstall.mockClear();

    await runDaemonCommand([
      "daemon",
      "install",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--json",
    ]);

    expect(serviceInstall).toHaveBeenCalledTimes(1);
    const parsed = parseFirstJsonRuntimeLine<{
      ok?: boolean;
      action?: string;
      result?: string;
    }>();
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("install");
    expect(parsed.result).toBe("installed");
  });

  it("passes the existing service environment into the install plan on forced reinstall", async () => {
    runtimeLogs.length = 0;
    serviceIsLoaded.mockResolvedValueOnce(true);
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_WRAPPER: "/usr/local/bin/openclaw-doppler",
        PATH: "/custom/go/bin:/usr/bin",
        GOPATH: "/Users/test/.local/gopath",
        GOBIN: "/Users/test/.local/gopath/bin",
      },
      sourcePath: "/tmp/ai.openclaw.gateway.plist",
    });

    await runDaemonCommand(["daemon", "install", "--force", "--json"]);

    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        existingEnvironment: {
          PATH: "/custom/go/bin:/usr/bin",
          OPENCLAW_WRAPPER: "/usr/local/bin/openclaw-doppler",
          GOPATH: "/Users/test/.local/gopath",
          GOBIN: "/Users/test/.local/gopath/bin",
        },
        env: expect.objectContaining({
          OPENCLAW_WRAPPER: "/usr/local/bin/openclaw-doppler",
        }),
      }),
    );
  });

  it("passes an explicit service wrapper into the install plan", async () => {
    runtimeLogs.length = 0;
    serviceIsLoaded.mockResolvedValueOnce(false);

    await runDaemonCommand([
      "daemon",
      "install",
      "--wrapper",
      "/usr/local/bin/openclaw-doppler",
      "--json",
    ]);

    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        wrapperPath: "/usr/local/bin/openclaw-doppler",
      }),
    );
  });

  it("starts and stops daemon (json output)", async () => {
    runtimeLogs.length = 0;
    serviceRestart.mockClear();
    serviceStop.mockClear();
    serviceIsLoaded.mockResolvedValue(true);

    await runDaemonCommand(["daemon", "start", "--json"]);
    await runDaemonCommand(["daemon", "stop", "--json"]);

    expect(serviceRestart).toHaveBeenCalledTimes(1);
    expect(serviceStop).toHaveBeenCalledTimes(1);
    const jsonLines = runtimeLogs.filter((line) => line.trim().startsWith("{"));
    const parsed = jsonLines.map((line) => JSON.parse(line) as { action?: string; ok?: boolean });
    expect(parsed.some((entry) => entry.action === "start" && entry.ok === true)).toBe(true);
    expect(parsed.some((entry) => entry.action === "stop" && entry.ok === true)).toBe(true);
  });
});
