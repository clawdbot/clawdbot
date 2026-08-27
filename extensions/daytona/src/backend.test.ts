import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDaytonaPluginConfig, type ResolvedDaytonaPluginConfig } from "./config.js";

type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

type FakeSandbox = {
  id: string;
  name: string;
  state: string;
  snapshot?: string;
  start: ReturnType<typeof vi.fn>;
  refreshData: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  fs: { uploadFile: ReturnType<typeof vi.fn>; deleteFile: ReturnType<typeof vi.fn> };
  process: {
    createSession: ReturnType<typeof vi.fn>;
    executeSessionCommand: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  };
};

type FakeClient = {
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const clientMocks = vi.hoisted(() => ({
  createDaytonaClient: vi.fn(),
  resolveDaytonaConnection: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createDaytonaClient: clientMocks.createDaytonaClient,
  resolveDaytonaConnection: clientMocks.resolveDaytonaConnection,
  isDaytonaNotFoundError: (error: unknown) =>
    (error as { statusCode?: number } | null)?.statusCode === 404,
  withDaytonaRetry: async <T>(_label: string, run: () => Promise<T>) => await run(),
}));

const { createDaytonaSandboxBackendFactory, createDaytonaSandboxBackendManager } =
  await import("./backend.js");

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  clientMocks.createDaytonaClient.mockReset();
  clientMocks.resolveDaytonaConnection.mockReset();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  // Canonicalize so macOS /var -> /private/var symlinks do not break
  // remote-path assertions against `pwd -P` output.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function notFoundError(): Error & { statusCode: number } {
  return Object.assign(new Error("sandbox not found"), { statusCode: 404 });
}

/**
 * Fake Daytona sandbox that executes toolbox commands through the local
 * /bin/sh and serves file uploads from the local filesystem, so the base64
 * command wrapper, tar seeding, and pinned fs mutations run for real.
 */
function createFakeSandbox(overrides?: Partial<Pick<FakeSandbox, "id" | "state" | "snapshot">>) {
  const sandbox: FakeSandbox = {
    id: overrides?.id ?? `sbx-${randomBytes(6).toString("hex")}`,
    name: "",
    state: overrides?.state ?? "started",
    snapshot: overrides?.snapshot,
    start: vi.fn(async () => {
      sandbox.state = "started";
    }),
    refreshData: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    fs: {
      uploadFile: vi.fn(async (source: Buffer | string, remotePath: string) => {
        if (Buffer.isBuffer(source)) {
          await fs.writeFile(remotePath, source);
          return;
        }
        await fs.copyFile(source, remotePath);
      }),
      deleteFile: vi.fn(async (remotePath: string) => {
        await fs.rm(remotePath, { force: true });
      }),
    },
    process: {
      createSession: vi.fn(async () => {
        // The real toolbox refuses session creation on a stopped sandbox.
        if (sandbox.state !== "started") {
          throw new Error("sandbox is not running");
        }
      }),
      executeSessionCommand: vi.fn(async (_sessionId: string, request: { command: string }) => {
        const result = spawnSync("/bin/sh", ["-c", request.command], {
          maxBuffer: 64 * 1024 * 1024,
        });
        return {
          cmdId: `cmd-${randomBytes(4).toString("hex")}`,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          exitCode: result.status ?? 1,
        };
      }),
      deleteSession: vi.fn(async () => {}),
    },
  };
  sandbox.name = `name-${sandbox.id}`;
  return sandbox;
}

function installFakeClient(params?: {
  existing?: FakeSandbox[];
  created?: FakeSandbox;
}): FakeClient {
  const existing = new Map((params?.existing ?? []).map((sandbox) => [sandbox.id, sandbox]));
  const client: FakeClient = {
    get: vi.fn(async (id: string) => {
      const sandbox = existing.get(id);
      if (!sandbox) {
        throw notFoundError();
      }
      return sandbox;
    }),
    create: vi.fn(async () => params?.created ?? createFakeSandbox()),
  };
  clientMocks.createDaytonaClient.mockResolvedValue(client);
  clientMocks.resolveDaytonaConnection.mockResolvedValue({
    apiKey: "test-api-key",
    apiUrl: "https://api.daytona.test",
  });
  return client;
}

function createBackendSandboxConfig(
  overrides?: Partial<CreateSandboxBackendParams["cfg"]>,
): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "daytona",
    scope: "agent",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "configured",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [],
      env: {},
    },
    ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
    browser: createSandboxBrowserConfig(),
    tools: { allow: ["*"], deny: [] },
    prune: createSandboxPruneConfig(),
    ...overrides,
  };
}

async function createTestSetup(params?: {
  cfg?: Partial<CreateSandboxBackendParams["cfg"]>;
  registeredRuntimeIds?: readonly string[];
  workspaceFiles?: Record<string, string>;
}) {
  const rootDir = await makeTempDir("openclaw-daytona-test-");
  const workspaceDir = path.join(rootDir, "local-workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  for (const [relative, content] of Object.entries(params?.workspaceFiles ?? {})) {
    const filePath = path.join(workspaceDir, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  const remoteWorkspaceDir = path.join(rootDir, "remote", "workspace");
  const remoteAgentWorkspaceDir = path.join(rootDir, "remote", "agent");
  const pluginConfig = resolveDaytonaPluginConfig({
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir,
  });
  const createParams: CreateSandboxBackendParams = {
    sessionKey: "agent:main:turn",
    scopeKey: "agent:main",
    ...(params?.registeredRuntimeIds ? { registeredRuntimeIds: params.registeredRuntimeIds } : {}),
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: createBackendSandboxConfig(params?.cfg),
  };
  return {
    rootDir,
    workspaceDir,
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir,
    pluginConfig,
    createParams,
  };
}

function createFactory(pluginConfig: ResolvedDaytonaPluginConfig) {
  return createDaytonaSandboxBackendFactory({
    pluginConfig,
    hostConfig: {} as OpenClawConfig,
  });
}

describe("daytona backend provisioning", () => {
  it("rejects sandbox.docker.binds", async () => {
    const setup = await createTestSetup({
      cfg: {
        docker: {
          ...createBackendSandboxConfig().docker,
          binds: ["/host:/container"],
        },
      },
    });
    installFakeClient();
    await expect(createFactory(setup.pluginConfig)(setup.createParams)).rejects.toThrow(
      "does not support sandbox.docker.binds",
    );
  });

  it("creates a labeled sandbox and seeds the workspace through tar upload", async () => {
    const setup = await createTestSetup({
      workspaceFiles: { "hello.txt": "hello daytona", "nested/data.txt": "nested" },
    });
    const created = createFakeSandbox();
    const client = installFakeClient({ created });

    const handle = await createFactory(setup.pluginConfig)(setup.createParams);

    expect(client.create).toHaveBeenCalledWith(
      {
        snapshot: undefined,
        labels: {
          "openclaw.sandbox": "1",
          "openclaw.scope": expect.stringMatching(/^[a-f0-9]{32}$/),
        },
        user: undefined,
        volumes: undefined,
        autoStopInterval: undefined,
        autoPauseInterval: undefined,
        autoArchiveInterval: undefined,
        autoDeleteInterval: undefined,
        networkBlockAll: true,
        networkAllowList: undefined,
        domainAllowList: undefined,
      },
      { timeout: 120 },
    );
    expect(handle.runtimeId).toBe(created.id);
    expect(handle.runtimeLabel).toBe(created.name);
    expect(handle.id).toBe("daytona");
    expect(handle.workdir).toBe(setup.remoteWorkspaceDir);
    expect(handle.configLabel).toBe("default");
    expect(handle.configLabelKind).toBe("Snapshot");
    expect(handle.workdirValidation).toBe("backend");

    await expect(
      fs.readFile(path.join(setup.remoteWorkspaceDir, "hello.txt"), "utf8"),
    ).resolves.toBe("hello daytona");
    await expect(
      fs.readFile(path.join(setup.remoteWorkspaceDir, "nested", "data.txt"), "utf8"),
    ).resolves.toBe("nested");
  });

  it("serializes provisioning across factories for the same scope", async () => {
    const setup = await createTestSetup({ workspaceFiles: { "seed.txt": "shared" } });
    const created = createFakeSandbox();
    const client = installFakeClient({ created });

    const [first, second] = await Promise.all([
      createFactory(setup.pluginConfig)(setup.createParams),
      createFactory(setup.pluginConfig)(setup.createParams),
    ]);

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(first.runtimeId).toBe(created.id);
    expect(second.runtimeId).toBe(created.id);
  });

  it("adopts a registered sandbox, skipping missing and unusable candidates", async () => {
    const setup = await createTestSetup({
      registeredRuntimeIds: ["missing-id", "errored-id", "usable-id"],
    });
    // The adopted sandbox already carries a seeded workspace root.
    await fs.mkdir(setup.remoteWorkspaceDir, { recursive: true });
    const errored = createFakeSandbox({ id: "errored-id", state: "error" });
    const usable = createFakeSandbox({ id: "usable-id", state: "stopped" });
    const client = installFakeClient({ existing: [errored, usable] });

    const handle = await createFactory(setup.pluginConfig)(setup.createParams);

    expect(handle.runtimeId).toBe("usable-id");
    expect(usable.start).toHaveBeenCalledTimes(1);
    expect(client.create).not.toHaveBeenCalled();
    expect(usable.fs.uploadFile).not.toHaveBeenCalled();
  });

  it("passes create-time sandbox settings through to Daytona", async () => {
    const setup = await createTestSetup();
    const pluginConfig = resolveDaytonaPluginConfig({
      snapshot: "team-snap",
      user: "runner",
      volumes: [{ volumeId: "vol-1", mountPath: "/data/shared" }],
      autoStopInterval: 0,
      autoArchiveInterval: 240,
      networkAllowList: "10.0.0.0/24",
      domainAllowList: "registry.npmjs.org",
      remoteWorkspaceDir: setup.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: setup.remoteAgentWorkspaceDir,
    });
    const client = installFakeClient({ created: createFakeSandbox() });

    const handle = await createFactory(pluginConfig)(setup.createParams);

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: "team-snap",
        user: "runner",
        volumes: [{ volumeId: "vol-1", mountPath: "/data/shared" }],
        autoStopInterval: 0,
        autoArchiveInterval: 240,
        networkBlockAll: false,
        networkAllowList: "10.0.0.0/24",
        domainAllowList: "registry.npmjs.org",
      }),
      { timeout: 120 },
    );
    expect(handle.configLabel).toBe("team-snap");
    expect(handle.configLabelKind).toBe("Snapshot");
  });

  it("creates image-based sandboxes with resources and a longer timeout floor", async () => {
    const setup = await createTestSetup();
    const pluginConfig = resolveDaytonaPluginConfig({
      image: "python:3.13-slim",
      resources: { cpu: 2, memory: 4, disk: 10 },
      remoteWorkspaceDir: setup.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: setup.remoteAgentWorkspaceDir,
    });
    const client = installFakeClient({ created: createFakeSandbox() });

    const handle = await createFactory(pluginConfig)(setup.createParams);

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "python:3.13-slim",
        resources: { cpu: 2, memory: 4, disk: 10 },
      }),
      { timeout: 600 },
    );
    expect(handle.configLabel).toBe("python:3.13-slim");
    expect(handle.configLabelKind).toBe("Image");
  });

  it("removes the staged seed tar when the extract transport fails", async () => {
    const setup = await createTestSetup({ workspaceFiles: { "seed.txt": "data" } });
    const created = createFakeSandbox();
    installFakeClient({ created });
    created.process.executeSessionCommand.mockRejectedValue(new Error("api 502"));

    await expect(createFactory(setup.pluginConfig)(setup.createParams)).rejects.toThrow("api 502");
    expect(created.delete).toHaveBeenCalledWith(120);
    const deletedPaths = created.fs.deleteFile.mock.calls.map((call) => call[0] as string);
    expect(deletedPaths.some((deletedPath) => deletedPath.startsWith("/tmp/openclaw-seed-"))).toBe(
      true,
    );
  });

  it("refuses to seed workspaces containing symlinks that escape the tree", async () => {
    const setup = await createTestSetup({ workspaceFiles: { "inside.txt": "data" } });
    await fs.symlink("/etc", path.join(setup.workspaceDir, "escape-link"));
    const created = createFakeSandbox();
    installFakeClient({ created });

    await expect(createFactory(setup.pluginConfig)(setup.createParams)).rejects.toThrow(
      /refuses symlink escaping the workspace: escape-link/,
    );
    expect(created.fs.uploadFile).not.toHaveBeenCalled();
  });

  it("allows workspace-internal symlinks during seeding", async () => {
    const setup = await createTestSetup({ workspaceFiles: { "inside.txt": "data" } });
    await fs.symlink(
      path.join(setup.workspaceDir, "inside.txt"),
      path.join(setup.workspaceDir, "internal-link"),
    );
    installFakeClient({ created: createFakeSandbox() });

    await createFactory(setup.pluginConfig)(setup.createParams);

    await expect(
      fs.readFile(path.join(setup.remoteWorkspaceDir, "inside.txt"), "utf8"),
    ).resolves.toBe("data");
  });

  it("re-seeds an adopted sandbox whose workspace root is missing", async () => {
    const setup = await createTestSetup({
      registeredRuntimeIds: ["reseed-id"],
      workspaceFiles: { "seed.txt": "reseeded" },
    });
    const adopted = createFakeSandbox({ id: "reseed-id" });
    installFakeClient({ existing: [adopted] });

    await createFactory(setup.pluginConfig)(setup.createParams);

    await expect(
      fs.readFile(path.join(setup.remoteWorkspaceDir, "seed.txt"), "utf8"),
    ).resolves.toBe("reseeded");
  });
});

describe("daytona backend exec", () => {
  it("builds a launcher exec spec with an owner-only payload file", async () => {
    vi.stubEnv("OPENAI_API_KEY", "super-secret");
    vi.stubEnv("LANG", "en_US.UTF-8");
    const setup = await createTestSetup();
    const created = createFakeSandbox();
    installFakeClient({ created });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);

    const spec = await handle.buildExecSpec({
      command: "echo hello",
      env: { OC_TEST: "1" },
      usePty: false,
    });

    expect(spec.argv[0]).toBe(process.execPath);
    expect(spec.argv[1]).toMatch(/daytona-exec-launcher\.mjs$/);
    expect(spec.argv[2]).toBe("--payload-file");
    expect(spec.stdinMode).toBe("pipe-open");
    expect(spec.env.OPENAI_API_KEY).toBeUndefined();
    expect(spec.env.LANG).toBe("en_US.UTF-8");

    const payloadFile = spec.argv[3] ?? "";
    const stat = await fs.stat(payloadFile);
    expect(stat.mode & 0o777).toBe(0o600);
    const payload = JSON.parse(await fs.readFile(payloadFile, "utf8")) as Record<string, unknown>;
    expect(payload.apiKey).toBe("test-api-key");
    expect(payload.sandboxId).toBe(created.id);
    expect(payload.usePty).toBe(false);
    expect(payload.cwd).toBe(setup.remoteWorkspaceDir);
    expect(payload.command).toContain("echo hello");
    expect(payload.command).toContain("cd ");
    expect(payload.command).toContain(setup.remoteWorkspaceDir);
    expect(payload.command).not.toContain("OC_TEST=1");
    expect(payload.env).toEqual({ OC_TEST: "1" });

    await handle.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: spec.finalizeToken,
    });
    await expect(fs.stat(payloadFile)).rejects.toThrow();
  });

  it("rejects malformed commands before contacting Daytona", async () => {
    const setup = await createTestSetup();
    installFakeClient({ created: createFakeSandbox() });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    const executeCallsBefore =
      (await clientMocks.createDaytonaClient.mock.results[0]?.value) !== undefined;
    expect(executeCallsBefore).toBe(true);

    await expect(
      handle.buildExecSpec({ command: "echo 'unterminated", env: {}, usePty: false }),
    ).rejects.toThrow();
  });
});

describe("daytona backend shell transport", () => {
  it("separates stdout and stderr binary-safely and reports exit codes", async () => {
    const setup = await createTestSetup();
    installFakeClient({ created: createFakeSandbox() });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);

    const result = await handle.runShellCommand({
      script: `printf 'a\\000b'; printf 'oops' >&2; exit 5`,
      allowFailure: true,
    });

    expect([...result.stdout]).toEqual([0x61, 0x00, 0x62]);
    expect(result.stderr.toString("utf8")).toBe("oops");
    expect(result.code).toBe(5);
  });

  it("pipes stdin through the sandbox and forwards script args", async () => {
    const setup = await createTestSetup();
    installFakeClient({ created: createFakeSandbox() });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);

    const result = await handle.runShellCommand({
      script: `cat; printf ':%s' "$@"`,
      args: ["first", "second arg"],
      stdin: Buffer.from([0x00, 0x01, 0xff]),
    });

    expect([...result.stdout.subarray(0, 3)]).toEqual([0x00, 0x01, 0xff]);
    expect(result.stdout.subarray(3).toString("utf8")).toBe(":first:second arg");
    expect(result.code).toBe(0);
  });

  it("rejects pre-aborted commands before contacting the sandbox", async () => {
    const setup = await createTestSetup();
    const created = createFakeSandbox();
    installFakeClient({ created });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    created.process.createSession.mockClear();
    created.process.executeSessionCommand.mockClear();

    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(
      handle.runShellCommand({ script: "true", signal: controller.signal }),
    ).rejects.toThrow("caller cancelled");
    expect(created.process.createSession).not.toHaveBeenCalled();
    expect(created.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("does not submit a command when aborted during stdin upload", async () => {
    const setup = await createTestSetup();
    const created = createFakeSandbox();
    installFakeClient({ created });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    created.process.executeSessionCommand.mockClear();
    let releaseUpload: (() => void) | undefined;
    const pendingUpload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    created.fs.uploadFile.mockReturnValueOnce(pendingUpload);

    const controller = new AbortController();
    const pending = handle.runShellCommand({
      script: "cat",
      stdin: Buffer.from("data"),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(releaseUpload).toBeTypeOf("function"));
    controller.abort(new Error("caller cancelled during upload"));
    releaseUpload?.();

    await expect(pending).rejects.toThrow("caller cancelled during upload");
    expect(created.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("does not submit a command when aborted during session creation", async () => {
    const setup = await createTestSetup();
    const created = createFakeSandbox();
    installFakeClient({ created });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    created.process.executeSessionCommand.mockClear();
    let releaseSession: (() => void) | undefined;
    const pendingSession = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    created.process.createSession.mockReturnValueOnce(pendingSession);

    const controller = new AbortController();
    const pending = handle.runShellCommand({
      script: "true",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(releaseSession).toBeTypeOf("function"));
    controller.abort(new Error("caller cancelled during session creation"));
    releaseSession?.();

    await expect(pending).rejects.toThrow("caller cancelled during session creation");
    expect(created.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("kills the remote session before reporting an abort and scrubs staging", async () => {
    const setup = await createTestSetup();
    const created = createFakeSandbox();
    installFakeClient({ created });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    // The in-flight session command hangs; the abort fires only once the
    // command is running so the staged stdin/out/err files already exist.
    const controller = new AbortController();
    created.process.deleteSession.mockClear();
    created.process.executeSessionCommand.mockReturnValue(new Promise(() => {}));

    const pending = handle.runShellCommand({
      script: "cat",
      stdin: Buffer.from("data"),
      signal: controller.signal,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(created.process.deleteSession).not.toHaveBeenCalled();
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
    // The rejection only travels through the abort path after the session
    // delete settled, so the remote command is dead before callers observe
    // the abort.
    expect(created.process.deleteSession).toHaveBeenCalled();
    const deletedPaths = created.fs.deleteFile.mock.calls.map((call) => call[0] as string);
    expect(deletedPaths.some((deletedPath) => deletedPath.startsWith("/tmp/openclaw-in-"))).toBe(
      true,
    );
    expect(deletedPaths.some((deletedPath) => deletedPath.startsWith("/tmp/openclaw-out-"))).toBe(
      true,
    );
    expect(deletedPaths.some((deletedPath) => deletedPath.startsWith("/tmp/openclaw-err-"))).toBe(
      true,
    );
  });

  it("removes staged transport files when the toolbox call fails", async () => {
    const setup = await createTestSetup();
    const created = createFakeSandbox();
    installFakeClient({ created });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    created.process.executeSessionCommand.mockRejectedValue(new Error("api 502"));

    await expect(
      handle.runShellCommand({ script: "cat", stdin: Buffer.from("data") }),
    ).rejects.toThrow("api 502");
    const deletedPaths = created.fs.deleteFile.mock.calls.map((call) => call[0] as string);
    expect(deletedPaths.some((deletedPath) => deletedPath.startsWith("/tmp/openclaw-in-"))).toBe(
      true,
    );
  });

  it("restarts an auto-stopped sandbox on the next filesystem operation", async () => {
    const setup = await createTestSetup();
    const created = createFakeSandbox();
    installFakeClient({ created });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    created.start.mockClear();
    // Simulate the Daytona idle auto-stop between two tool calls.
    created.state = "stopped";

    const result = await handle.runShellCommand({ script: "printf restarted" });

    expect(created.start).toHaveBeenCalledTimes(1);
    expect(result.stdout.toString("utf8")).toBe("restarted");
  });

  it("throws stderr text for failed commands unless allowFailure is set", async () => {
    const setup = await createTestSetup();
    installFakeClient({ created: createFakeSandbox() });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);

    await expect(handle.runShellCommand({ script: `printf 'boom' >&2; exit 3` })).rejects.toThrow(
      "boom",
    );
  });

  it("validates workdirs against managed remote roots", async () => {
    const setup = await createTestSetup();
    installFakeClient({ created: createFakeSandbox() });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    const nestedDir = path.join(setup.remoteWorkspaceDir, "nested");
    await fs.mkdir(nestedDir, { recursive: true });

    await expect(handle.validateWorkdir?.(nestedDir)).resolves.toBe(nestedDir);
    await expect(
      handle.validateWorkdir?.(path.join(setup.remoteWorkspaceDir, "missing")),
    ).resolves.toBeNull();
    await expect(handle.validateWorkdir?.("/etc")).resolves.toBeNull();
  });
});

describe("daytona fs bridge", () => {
  async function createBridgeSetup() {
    const setup = await createTestSetup({ workspaceFiles: { "existing.txt": "seeded" } });
    installFakeClient({ created: createFakeSandbox() });
    const handle = await createFactory(setup.pluginConfig)(setup.createParams);
    const context: SandboxFsBridgeContext = {
      workspaceDir: setup.workspaceDir,
      agentWorkspaceDir: setup.workspaceDir,
      workspaceAccess: "rw",
      containerName: handle.runtimeId,
      containerWorkdir: setup.remoteWorkspaceDir,
      docker: {},
      backend: { runShellCommand: (params) => handle.runShellCommand(params) },
    };
    const bridge = handle.createFsBridge?.({ sandbox: context });
    if (!bridge) {
      throw new Error("daytona backend must provide an fs bridge");
    }
    return { setup, bridge };
  }

  it("writes, reads, renames, and removes files in the remote workspace", async () => {
    const { setup, bridge } = await createBridgeSetup();

    await bridge.writeFile({ filePath: "notes/todo.txt", data: "remember", mkdir: true });
    await expect(
      fs.readFile(path.join(setup.remoteWorkspaceDir, "notes", "todo.txt"), "utf8"),
    ).resolves.toBe("remember");

    const read = await bridge.readFile({ filePath: "notes/todo.txt" });
    expect(read.toString("utf8")).toBe("remember");

    await bridge.rename({ from: "notes/todo.txt", to: "notes/done.txt" });
    await expect(
      fs.readFile(path.join(setup.remoteWorkspaceDir, "notes", "done.txt"), "utf8"),
    ).resolves.toBe("remember");
    await expect(
      fs.stat(path.join(setup.remoteWorkspaceDir, "notes", "todo.txt")),
    ).rejects.toThrow();

    await bridge.remove({ filePath: "notes", recursive: true });
    await expect(fs.stat(path.join(setup.remoteWorkspaceDir, "notes"))).rejects.toThrow();
  });

  // The bridge stat op shells out to GNU `stat -c`; sandbox images are Linux,
  // while macOS dev machines carry BSD stat, so this proof runs on Linux CI.
  it.runIf(process.platform === "linux")("stats files through the remote transport", async () => {
    const { bridge } = await createBridgeSetup();
    await bridge.writeFile({ filePath: "stat-me.txt", data: "12345678" });
    const stat = await bridge.stat({ filePath: "stat-me.txt" });
    expect(stat).toMatchObject({ type: "file", size: 8 });
    await expect(bridge.stat({ filePath: "missing.txt" })).resolves.toBeNull();
  });

  it("enforces read limits", async () => {
    const { bridge } = await createBridgeSetup();
    await bridge.writeFile({ filePath: "big.txt", data: "0123456789" });
    await expect(bridge.readFile({ filePath: "big.txt", maxBytes: 4 })).rejects.toThrow();
    await expect(bridge.readFile({ filePath: "big.txt", maxBytes: 10 })).resolves.toBeDefined();
  });

  it("rejects paths escaping the managed mounts", async () => {
    const { bridge } = await createBridgeSetup();
    await expect(bridge.readFile({ filePath: "/etc/passwd" })).rejects.toThrow(
      /escapes allowed mounts/,
    );
  });
});

describe("daytona backend manager", () => {
  it("describes runtimes from live sandbox state", async () => {
    const sandbox = createFakeSandbox({ id: "sbx-desc", snapshot: "custom-snap" });
    installFakeClient({ existing: [sandbox] });
    const manager = createDaytonaSandboxBackendManager({
      pluginConfig: resolveDaytonaPluginConfig(undefined),
      hostConfig: {} as OpenClawConfig,
    });

    const entry = {
      containerName: "sbx-desc",
      sessionKey: "agent:main",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      image: "default",
    };
    await expect(manager.describeRuntime({ entry, config: {} as OpenClawConfig })).resolves.toEqual(
      {
        running: true,
        actualConfigLabel: "custom-snap",
        configLabelMatch: true,
      },
    );

    sandbox.state = "stopped";
    await expect(
      manager.describeRuntime({
        entry: { ...entry, image: "other-snapshot" },
        config: {} as OpenClawConfig,
      }),
    ).resolves.toEqual({
      running: false,
      actualConfigLabel: "custom-snap",
      configLabelMatch: false,
    });
  });

  it("treats missing sandboxes as not running and removes idempotently", async () => {
    const sandbox = createFakeSandbox({ id: "sbx-remove" });
    installFakeClient({ existing: [sandbox] });
    const manager = createDaytonaSandboxBackendManager({
      pluginConfig: resolveDaytonaPluginConfig(undefined),
      hostConfig: {} as OpenClawConfig,
    });
    const missingEntry = {
      containerName: "gone",
      sessionKey: "agent:main",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      image: "default",
    };

    await expect(
      manager.describeRuntime({ entry: missingEntry, config: {} as OpenClawConfig }),
    ).resolves.toEqual({ running: false, configLabelMatch: true });
    await expect(
      manager.removeRuntime({ entry: missingEntry, config: {} as OpenClawConfig }),
    ).resolves.toBeUndefined();

    await manager.removeRuntime({
      entry: { ...missingEntry, containerName: "sbx-remove" },
      config: {} as OpenClawConfig,
    });
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
  });
});
