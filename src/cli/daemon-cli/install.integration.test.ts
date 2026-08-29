import { spawnSync } from "node:child_process";
// Daemon install integration tests cover service install paths with filesystem fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
} from "../../daemon/service-types.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "../../daemon/service.test-helpers.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { captureEnv } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();
const busctl = vi.hoisted(() =>
  vi.fn<typeof import("../../daemon/systemd-exec.js").execBusctlUser>(),
);
vi.mock("../../daemon/systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-exec.js")>()),
  execBusctlUser: busctl,
}));
vi.mock("../../daemon/systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-system.js")>()),
  assertNoSystemSystemdOwnership: async () => {},
}));

const serviceMock = vi.hoisted(() => ({
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  stage: vi.fn(async (_opts?: { environment?: Record<string, string | undefined> }) => {}),
  install: vi.fn(async (_opts?: GatewayServiceInstallArgs) => {}),
  uninstall: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  isLoaded: vi.fn(async () => false),
  readDefinitionMutationCapability: vi.fn<
    (args?: {
      env?: NodeJS.ProcessEnv;
      environment?: NodeJS.ProcessEnv;
    }) => Promise<import("../../daemon/service-types.js").ServiceDefinitionMutationCapability>
  >(async (_args?: { env?: NodeJS.ProcessEnv; environment?: NodeJS.ProcessEnv }) => ({
    kind: "writable" as const,
  })),
  readCommand: vi.fn<
    typeof import("../../daemon/systemd-service-files.js").readSystemdServiceExecStart
  >(async () => null),
  readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
}));

vi.mock("../../config/paths.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/paths.js")>("../../config/paths.js");
  return { ...actual, isDefaultInstallIdentity: () => true };
});

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => serviceMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

const { mergeInstallInvocationEnv, runDaemonInstall } = await import("./install.js");
const { clearConfigCache, clearRuntimeConfigSnapshot, readConfigFileSnapshot } =
  await import("../../config/config.js");
const { readSystemdDefinitionMutationCapability } =
  await import("../../daemon/systemd-definition-mutation.js");
const { readSystemdServiceExecStart } = await import("../../daemon/systemd-service-files.js");
const { assertServiceDefinitionWritable } = await import("../../daemon/service-types.js");

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function createInstalledServiceCommand() {
  // An installed service has already observed its config; include that health store in snapshots.
  await readConfigFileSnapshot();
  const programArguments = ["openclaw", "gateway", "run"];
  const environment = buildServiceEnvironment({
    env: process.env,
    port: 18789,
    execPath: programArguments[0],
  });
  return {
    programArguments,
    // Service readers return only persisted strings, including the host's required TLS CA bundle.
    environment: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

describe("runDaemonInstall integration", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let configPath: string;

  async function snapshotConfig() {
    const contents = await fs.readFile(configPath);
    const { ino, mode, uid } = await fs.lstat(configPath);
    return { contents, ino, mode, uid, entries: (await fs.readdir(tempHome)).toSorted() };
  }

  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    tempHome = await makeTempWorkspace("openclaw-daemon-install-int-");
    configPath = path.join(tempHome, "openclaw.json");
    process.env.HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });

  afterAll(async () => {
    envSnapshot.restore();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    clearRuntimeConfigSnapshot();
    // Keep these defined-but-empty so dotenv won't repopulate from local .env.
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    serviceMock.isLoaded.mockResolvedValue(false);
    serviceMock.readDefinitionMutationCapability.mockResolvedValue({ kind: "writable" });
    serviceMock.readCommand.mockReset();
    serviceMock.readCommand.mockResolvedValue(null);
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    clearConfigCache();
  });

  it("fails closed when token SecretRef is required but unresolved", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            auth: {
              mode: "token",
              token: {
                source: "env",
                provider: "default",
                id: "MISSING_GATEWAY_TOKEN",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();

    await expect(runDaemonInstall({ json: true })).rejects.toThrow("__exit__:1");
    expect(serviceMock.install).not.toHaveBeenCalled();
    const joined = runtimeLogs.join("\n");
    expect(joined).toContain("SecretRef is configured but unresolved");
    expect(joined).toContain("MISSING_GATEWAY_TOKEN");
  });

  it.each([true, false])(
    "explains unsafe publication permissions and recovers without bypassing SecretRefs (json=%s)",
    async (json) => {
      const fixture = await fs.realpath(
        await fs.mkdtemp(path.join(tempHome, "private-path-canary-")),
      );
      const ancestor = path.join(fixture, ".config");
      const config = {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
          },
        },
      };
      await fs.mkdir(ancestor);
      await fs.chmod(ancestor, 0o777);
      await fs.writeFile(configPath, JSON.stringify(config));
      clearConfigCache();
      busctl.mockResolvedValue({
        code: 1,
        termination: "exit",
        stdout: "",
        stderr: "Call failed: Unit openclaw-gateway.service not found.",
      });
      const env = { ...process.env, HOME: fixture, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway" };
      serviceMock.readCommand.mockImplementation((_env, options) =>
        readSystemdServiceExecStart(env, options),
      );
      serviceMock.readDefinitionMutationCapability.mockImplementation(() =>
        readSystemdDefinitionMutationCapability(env),
      );
      const before = await snapshotConfig();
      try {
        await expect(runDaemonInstall({ json, force: true })).rejects.toThrow("__exit__:1");
        expect(await snapshotConfig()).toEqual(before);
        expect(await fs.readdir(ancestor)).toEqual([]);
        expect(serviceMock.install).not.toHaveBeenCalled();
        const output = [...runtimeLogs, ...runtimeErrors].join("\n");
        expect(output).toContain("SERVICE_DEFINITION_UNKNOWN");
        expect(output).toContain("unsafe-permissions");
        expect(output).toContain("service directory");
        expect(output).toContain("group/world-writable");
        expect(output).toContain("chmod go-w");
        expect(output).not.toContain("private-path-canary");
        expect(output).not.toContain("MISSING_GATEWAY_TOKEN");

        await fs.chmod(ancestor, 0o700);
        resetRuntimeCapture();
        await expect(runDaemonInstall({ json, force: true })).rejects.toThrow("__exit__:1");
        const recovered = [...runtimeLogs, ...runtimeErrors].join("\n");
        expect(recovered).not.toContain("SERVICE_DEFINITION_UNKNOWN");
        expect(recovered).toContain("SecretRef is configured but unresolved");
        expect((await readJson(configPath)).gateway).toEqual({ ...config.gateway, mode: "local" });
        expect(await fs.readdir(ancestor)).toEqual([]);
        expect(serviceMock.install).not.toHaveBeenCalled();
      } finally {
        await fs.chmod(ancestor, 0o700);
        await fs.rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each(["fragment", "drop-in"])(
    "blocks a root-owned manager %s before config or token writes",
    async (kind) => {
      const fixture = await fs.realpath(await fs.mkdtemp(path.join(tempHome, "manager-owner-")));
      const unitPath = path.join(fixture, ".config/systemd/user/openclaw-gateway.service");
      const extra = path.join(fixture, "global-user", "operator.conf");
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.mkdir(path.dirname(extra));
      await fs.writeFile(extra, "[Service]\nEnvironment=TOKEN=operator-secret-canary\n");
      if (kind === "drop-in") {
        await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      }
      const originalLstat = fs.lstat.bind(fs);
      const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await originalLstat(...args);
        if (args[0] === extra) {
          Object.defineProperty(stat, "uid", { value: 0 });
        }
        return stat;
      });
      busctl.mockImplementation(async (_env, args) => ({
        code: 0,
        termination: "exit",
        stderr: "",
        stdout: args.includes("LoadUnit")
          ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
          : args.includes("org.freedesktop.systemd1.Unit")
            ? buildSystemdUnitPropertyOutput({
                fragmentPath: kind === "fragment" ? extra : unitPath,
                dropInPaths: kind === "fragment" ? [] : [extra],
              })
            : buildSystemdManagerPropertyOutput({ programArguments: ["/usr/bin/node", "gateway"] }),
      }));
      const env = { ...process.env, HOME: fixture, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway" };
      serviceMock.readCommand.mockImplementationOnce((_env, options) =>
        readSystemdServiceExecStart(env, options),
      );
      serviceMock.readDefinitionMutationCapability.mockImplementationOnce(() =>
        readSystemdDefinitionMutationCapability(env),
      );
      const before = await snapshotConfig();
      const managedEntries = await fs.readdir(path.dirname(unitPath));
      try {
        await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");
        expect(await snapshotConfig()).toEqual(before);
        expect(await fs.readdir(path.dirname(unitPath))).toEqual(managedEntries);
        expect(await fs.readFile(extra, "utf8")).toContain("operator-secret-canary");
        expect(serviceMock.install).not.toHaveBeenCalled();
        expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
        expect(runtimeLogs.join("\n")).not.toContain("secret-canary");
      } finally {
        lstat.mockRestore();
        await fs.rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("checks the planned generated environment after a drop-in redirects effective state", async () => {
    const fixture = await fs.realpath(await fs.mkdtemp(path.join(tempHome, "planned-owner-")));
    const plannedState = path.join(fixture, "planned");
    const effectiveState = path.join(fixture, "effective");
    const unit = path.join(fixture, ".config/systemd/user/openclaw-gateway.service");
    const dropIn = `${unit}.d/override.conf`;
    const plannedFile = path.join(plannedState, "gateway.systemd.env");
    const effectiveFile = path.join(effectiveState, "gateway.systemd.env");
    const invocation = captureEnv(["HOME", "OPENCLAW_STATE_DIR"]);
    await fs.mkdir(path.dirname(dropIn), { recursive: true });
    await fs.mkdir(plannedState);
    await fs.mkdir(effectiveState);
    await fs.writeFile(plannedFile, "OPERATOR_VALUE=planned\n");
    await fs.writeFile(effectiveFile, "OPERATOR_VALUE=effective\n");
    await fs.writeFile(
      unit,
      `[Service]\nExecStart=/usr/bin/node gateway\nEnvironment=OPENCLAW_STATE_DIR=${plannedState}\nEnvironmentFile=${plannedFile}\n`,
    );
    await fs.writeFile(
      dropIn,
      `[Service]\nEnvironment=OPENCLAW_STATE_DIR=${effectiveState}\nEnvironmentFile=\nEnvironmentFile=${effectiveFile}\n`,
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { auth: { mode: "token", token: "existing-token" } } }),
    );
    process.env.HOME = fixture;
    process.env.OPENCLAW_STATE_DIR = plannedState;
    clearConfigCache();
    const lstat = fs.lstat.bind(fs);
    const owner = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === plannedFile) {
        Object.defineProperty(stat, "uid", { value: 0 });
      }
      return stat;
    });
    busctl.mockImplementation(async (_env, args) => ({
      code: 0,
      termination: "exit",
      stderr: "",
      stdout: args.includes("LoadUnit")
        ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
        : args.includes("org.freedesktop.systemd1.Unit")
          ? buildSystemdUnitPropertyOutput({ fragmentPath: unit, dropInPaths: [dropIn] })
          : buildSystemdManagerPropertyOutput({
              programArguments: ["/usr/bin/node", "gateway"],
              environment: [`OPENCLAW_STATE_DIR=${effectiveState}`],
              environmentFiles: [[effectiveFile, false]],
            }),
    }));
    serviceMock.readCommand.mockImplementation(readSystemdServiceExecStart);
    serviceMock.readDefinitionMutationCapability.mockImplementation((args) =>
      readSystemdDefinitionMutationCapability(args?.env ?? process.env, {
        environment: args?.environment,
      }),
    );
    // Model the actual writer's planned scope without operating a native manager.
    serviceMock.install.mockImplementationOnce(async (args) => {
      assertServiceDefinitionWritable(
        await readSystemdDefinitionMutationCapability(process.env, {
          environment: args?.environment,
        }),
      );
    });
    const before = await snapshotConfig();
    try {
      await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");
      expect(await snapshotConfig()).toEqual(before);
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
      expect(await fs.readdir(plannedState)).toEqual(["gateway.systemd.env"]);
      expect(await fs.readdir(effectiveState)).toEqual(["gateway.systemd.env"]);
    } finally {
      owner.mockRestore();
      invocation.restore();
      serviceMock.install.mockReset().mockResolvedValue(undefined);
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("refuses service install when config was written by a newer OpenClaw", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          meta: {
            lastTouchedVersion: "9999.1.1",
          },
          gateway: {
            auth: {
              mode: "token",
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();

    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("Refusing to install or rewrite the gateway service");
  });

  it.each([
    {
      name: "gateway.mode is missing",
      capability: { kind: "sealed" as const, reason: "foreign-owner" as const },
      config: { gateway: { auth: { mode: "token", token: "existing-token" } } },
      marker: "SERVICE_DEFINITION_SEALED",
    },
    {
      name: "the gateway token is missing",
      capability: { kind: "sealed" as const, reason: "foreign-owner" as const },
      config: { gateway: { mode: "local", auth: { mode: "token" } } },
      marker: "SERVICE_DEFINITION_SEALED",
    },
    {
      name: "gateway.mode is missing and definition authority is unknown",
      capability: { kind: "unknown" as const, reason: "inspection-failed" as const },
      config: { gateway: { auth: { mode: "token" } } },
      marker: "SERVICE_DEFINITION_UNKNOWN",
    },
  ])(
    "preserves config bytes and directory entries when definition access is refused and $name",
    async ({ capability, config, marker }) => {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      clearConfigCache();
      serviceMock.readDefinitionMutationCapability.mockResolvedValueOnce(capability);
      const before = await snapshotConfig();

      await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

      expect(await snapshotConfig()).toEqual(before);
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(serviceMock.readCommand).toHaveBeenCalledOnce();
      expect(runtimeLogs.join("\n")).toContain(marker);
      expect(runtimeLogs.join("\n")).toContain(
        capability.kind === "sealed" ? "deployment owner" : "Inspect service definition access",
      );
    },
  );

  it.each([
    { name: "forced fresh install", loaded: false, force: true },
    { name: "loaded auto-refresh", loaded: true, force: false },
    { name: "forced loaded refresh", loaded: true, force: true },
  ])(
    "preserves config, token, and state when $name cannot inspect its command",
    async ({ loaded, force }) => {
      const secret = "service-command-inspection-secret-canary";
      await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
      clearConfigCache();
      serviceMock.isLoaded.mockResolvedValue(loaded);
      serviceMock.readCommand.mockRejectedValueOnce(new Error(secret));
      const before = await snapshotConfig();

      await expect(runDaemonInstall({ json: true, force })).rejects.toThrow("__exit__:1");

      expect(await snapshotConfig()).toEqual(before);
      expect(serviceMock.readCommand).toHaveBeenCalledWith(expect.any(Object), {
        requireEffective: true,
      });
      expect(serviceMock.readDefinitionMutationCapability).not.toHaveBeenCalled();
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_UNKNOWN");
      expect(runtimeLogs.join("\n")).not.toContain(secret);
    },
  );

  it("keeps an already-installed service read-only without probing definition authority", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "local", auth: { mode: "token", token: "existing" } } }),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue(await createInstalledServiceCommand());
    const before = await snapshotConfig();

    await runDaemonInstall({ json: true });

    expect(runtimeLogs.join("\n")).toContain('"result": "already-installed"');
    expect(serviceMock.readDefinitionMutationCapability).not.toHaveBeenCalled();
    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(await snapshotConfig()).toEqual(before);
  });

  it("repairs missing gateway mode for a loaded sealed service without rewriting its definition", async () => {
    const config = { gateway: { auth: { mode: "token", token: "existing-token" } } };
    await fs.writeFile(configPath, JSON.stringify(config));
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      reason: "foreign-owner",
    });
    serviceMock.readCommand.mockResolvedValue(await createInstalledServiceCommand());

    await runDaemonInstall({ json: true });

    expect((await readJson(configPath)).gateway).toEqual({ ...config.gateway, mode: "local" });
    expect(runtimeLogs.join("\n")).toContain('"result": "already-installed"');
    expect(serviceMock.readDefinitionMutationCapability).not.toHaveBeenCalled();
    expect(serviceMock.install).not.toHaveBeenCalled();
  });

  it("refuses loaded-service auto-refresh before persisting missing gateway defaults", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { auth: { mode: "token", token: "existing-token" } } }),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: { OPENCLAW_GATEWAY_TOKEN: "outdated-token" },
    } as never);
    serviceMock.readDefinitionMutationCapability.mockResolvedValueOnce({
      kind: "sealed",
      reason: "foreign-owner",
    });
    const before = await snapshotConfig();

    await expect(runDaemonInstall({ json: true })).rejects.toThrow("__exit__:1");

    expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(await snapshotConfig()).toEqual(before);
  });

  it("refuses a loaded service's sealed effective state before persisting config or a token", async () => {
    const effectiveStateDir = path.join(tempHome, "sealed-service-state");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: { OPENCLAW_STATE_DIR: effectiveStateDir },
    } as never);
    serviceMock.readDefinitionMutationCapability.mockImplementationOnce(async (args) =>
      args?.environment?.OPENCLAW_STATE_DIR === effectiveStateDir
        ? { kind: "sealed", reason: "foreign-owner" }
        : { kind: "writable" },
    );
    const before = await snapshotConfig();

    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

    expect(serviceMock.readDefinitionMutationCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: tempHome }),
        environment: expect.objectContaining({ OPENCLAW_STATE_DIR: effectiveStateDir }),
      }),
    );
    expect(await snapshotConfig()).toEqual(before);
    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
  });

  it.each([
    { name: "sealed definition without force", kind: "sealed", force: false },
    { name: "sealed definition with force", kind: "sealed", force: true },
    { name: "uninspectable definition", kind: "unknown", force: true },
    { name: "rejected definition inspection", kind: "rejected", force: false },
  ])("leaves absent config and state untouched for $name", async ({ kind, force }) => {
    const stateDir = await fs.mkdtemp(path.join(tempHome, "sealed-install-"));
    const missingConfigPath = path.join(stateDir, "openclaw.json");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const secret = "direct-install-capability-secret-canary";
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = missingConfigPath;
    clearConfigCache();
    if (kind === "rejected") {
      serviceMock.readDefinitionMutationCapability.mockRejectedValueOnce(new Error(secret));
    } else {
      serviceMock.readDefinitionMutationCapability.mockResolvedValueOnce({
        kind,
        reason: kind === "sealed" ? "foreign-owner" : "inspection-failed",
        detail: secret,
      } as never);
    }

    try {
      await expect(runDaemonInstall({ json: true, force })).rejects.toThrow("__exit__:1");

      expect(await fs.readdir(stateDir)).toEqual([]);
      await expect(fs.access(missingConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(serviceMock.readCommand).toHaveBeenCalledOnce();
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(runtimeLogs.join("\n")).toContain(
        kind === "sealed" ? "SERVICE_DEFINITION_SEALED" : "SERVICE_DEFINITION_UNKNOWN",
      );
      expect(runtimeLogs.join("\n")).not.toContain(secret);
    } finally {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      clearConfigCache();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("auto-mints token when no source exists without embedding it into service env", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          gateway: {
            auth: {
              mode: "token",
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runDaemonInstall({ json: true });

    expect(serviceMock.install).toHaveBeenCalledTimes(1);
    const updated = await readJson(configPath);
    const gateway = (updated.gateway ?? {}) as { auth?: { token?: string } };
    const persistedToken = gateway.auth?.token;
    expect(persistedToken).toEqual(expect.stringMatching(/^[0-9a-f]{48}$/));

    const installEnv = serviceMock.install.mock.calls[0]?.[0]?.environment;
    expect(installEnv?.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it("logs a generated-token warning without callback indexes or warning arrays", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "local", auth: { mode: "token" } } }),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runDaemonInstall({});

    expect(
      defaultRuntime.log.mock.calls.filter(([message]) =>
        String(message).includes("No gateway token found"),
      ),
    ).toEqual([["No gateway token found. Auto-generated one and saving to config."]]);
  });

  it.each([
    {
      name: "operator heap cap",
      options: "--max-old-space-size=512",
      overrides: { environment: { keys: ["NODE_OPTIONS"] } },
      expected: [],
    },
    {
      name: "same-value empty override",
      options: "",
      overrides: { environment: { keys: ["NODE_OPTIONS"] } },
      expected: [],
    },
    {
      name: "UnsetEnvironment",
      options: undefined,
      overrides: { environment: { keys: ["NODE_OPTIONS"] } },
      expected: [],
    },
    {
      name: "inline reset",
      options: undefined,
      overrides: { environment: { resetInline: true } },
      expected: [],
    },
    {
      name: "file reset",
      options: undefined,
      source: "file",
      overrides: { environment: { resetFiles: true } },
      expected: [],
    },
    {
      name: "unknown environment authority",
      options: "",
      overrides: { environment: true },
      expected: [],
    },
    {
      name: "legacy effective difference",
      options: "--max-old-space-size=512",
      overrides: undefined,
      expected: [],
    },
    {
      name: "PATH-only override",
      options: "",
      overrides: { environment: { keys: ["PATH"] } },
      expected: ["--max-old-space-size=16384"],
    },
    {
      name: "stored managed argv",
      options: "--max-old-space-size=512",
      baseArgs: ["--max-old-space-size=1024"],
      overrides: { environment: { keys: ["NODE_OPTIONS"] } },
      expected: ["--max-old-space-size=1024"],
    },
  ] satisfies Array<{
    name: string;
    options: string | undefined;
    source?: "file";
    baseArgs?: string[];
    overrides: GatewayServiceCommandConfig["managedOverrides"];
    expected: string[];
  }>)(
    "preserves $name through the real install plan without importing operator values",
    async (testCase) => {
      const originalArgv = process.argv;
      const physical = vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 ** 3);
      const constrained = vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
      const entry = path.join(tempHome, "dist", "index.js");
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(entry, "");
      process.argv = [process.execPath, entry];
      const programArguments = [
        process.execPath,
        ...(testCase.baseArgs ?? []),
        entry,
        "gateway",
        "--port",
        "19991",
      ];
      serviceMock.readCommand.mockResolvedValue({
        programArguments,
        environment: {
          ...(testCase.options === undefined ? {} : { NODE_OPTIONS: testCase.options }),
          PATH: "/operator/bin",
        },
        managedDefinition: {
          programArguments,
          environment: { NODE_OPTIONS: "" },
          ...(testCase.source
            ? { environmentValueSources: { NODE_OPTIONS: testCase.source } }
            : {}),
        },
        managedOverrides: testCase.overrides,
      });
      try {
        serviceMock.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await runDaemonInstall({ json: true, force: true });
        expect(serviceMock.install).toHaveBeenCalledOnce();
        const plan = serviceMock.install.mock.calls[0]?.[0];
        expect(plan?.environment?.NODE_OPTIONS).toBe("");
        expect(plan?.environment?.PATH).not.toContain("/operator/bin");
        const generatedArgs = plan?.programArguments ?? [];
        const heapArgs = generatedArgs.slice(1, generatedArgs.indexOf(entry));
        expect(heapArgs).toEqual(testCase.expected);
        if (testCase.name === "operator heap cap") {
          const measure = (flags: string[]) => {
            const child = spawnSync(
              process.execPath,
              [
                ...flags,
                "-e",
                "console.log(require('node:v8').getHeapStatistics().heap_size_limit)",
              ],
              { env: { NODE_OPTIONS: testCase.options }, encoding: "utf8" },
            );
            expect(child.status, child.stderr).toBe(0);
            return Number(child.stdout);
          };
          expect(measure(heapArgs)).toBe(measure([]));
        }
      } finally {
        process.argv = originalArgv;
        physical.mockRestore();
        constrained.mockRestore();
      }
    },
  );
});

describe("mergeInstallInvocationEnv", () => {
  it("canonicalizes Windows install env keys while filtering dangerous loader env", () => {
    const env = mergeInstallInvocationEnv({
      env: {
        Path: "C:\\Windows\\System32",
        openai_api_key: "service-openai-key",
        NODE_OPTIONS: "--require C:\\temp\\untrusted.js",
      },
      platform: "win32",
    });

    expect(env).toMatchObject({
      PATH: "C:\\Windows\\System32",
      OPENAI_API_KEY: "service-openai-key",
    });
    expect(env.Path).toBeUndefined();
    expect(env.openai_api_key).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it.each([
    { platform: "darwin" as const, caKey: "NODE_EXTRA_CA_CERTS" },
    { platform: "linux" as const, caKey: "NODE_EXTRA_CA_CERTS" },
    { platform: "win32" as const, caKey: "node_extra_ca_certs" },
  ])(
    "preserves installed additive Node CA trust without unsafe overrides on $platform",
    ({ platform, caKey }) => {
      const env = mergeInstallInvocationEnv({
        env: { PATH: "/usr/bin" },
        existingServiceEnv: {
          [caKey]: " /opt/openclaw/corporate-ca.pem ",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          HTTPS_PROXY: "https://attacker.invalid",
          NODE_OPTIONS: "--require /tmp/untrusted.js",
          BASH_ENV: "/tmp/untrusted.sh",
          LD_PRELOAD: "/tmp/untrusted.so",
          OPENAI_API_KEY: "existing-service-key",
        },
        platform,
      });

      expect(env).toMatchObject({
        NODE_EXTRA_CA_CERTS: "/opt/openclaw/corporate-ca.pem",
        OPENAI_API_KEY: "existing-service-key",
        PATH: "/usr/bin",
      });
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.BASH_ENV).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      if (platform === "win32") {
        expect(env.node_extra_ca_certs).toBeUndefined();
      }
    },
  );

  it.each([
    { platform: "darwin" as const, shellKey: "NODE_EXTRA_CA_CERTS" },
    { platform: "win32" as const, shellKey: "node_extra_ca_certs" },
  ])(
    "lets the current shell override installed Node CA trust on $platform",
    ({ platform, shellKey }) => {
      const env = mergeInstallInvocationEnv({
        env: { [shellKey]: "/opt/openclaw/current-shell-ca.pem" },
        existingServiceEnv: {
          NODE_EXTRA_CA_CERTS: "/opt/openclaw/previous-service-ca.pem",
        },
        platform,
      });

      expect(env.NODE_EXTRA_CA_CERTS).toBe("/opt/openclaw/current-shell-ca.pem");
    },
  );
});
