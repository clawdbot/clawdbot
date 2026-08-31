// Sandbox browser creation tests cover Docker args, bridge auth, noVNC access,
// config hashing, and cached bridge invalidation.
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  computeSandboxBrowserConfigHash,
  SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
} from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig } from "./config.js";
import {
  SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
  SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
  SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
} from "./constants.js";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

let BROWSER_BRIDGES: Map<string, unknown>;
let ensureSandboxBrowser: typeof import("./browser.js").ensureSandboxBrowser;
let capturedDockerCreateEnvEntries: string[] | undefined;

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  execDocker: vi.fn(),
  readDockerContainerEnvVar: vi.fn(),
  readDockerContainerLabel: vi.fn(),
  readDockerPort: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  updateBrowserRegistry: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  startBrowserBridgeServer: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    execDocker: dockerMocks.execDocker,
    readDockerContainerEnvVar: dockerMocks.readDockerContainerEnvVar,
    readDockerContainerLabel: dockerMocks.readDockerContainerLabel,
    readDockerPort: dockerMocks.readDockerPort,
  };
});

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  updateBrowserRegistry: registryMocks.updateBrowserRegistry,
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  startBrowserBridgeServer: bridgeMocks.startBrowserBridgeServer,
  stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

vi.mock("../../plugin-sdk/browser-profiles.js", () => ({
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS: 60_000,
  DEFAULT_BROWSER_EVALUATE_ENABLED: true,
  DEFAULT_OPENCLAW_BROWSER_COLOR: "#FF4500",
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: "openclaw",
  resolveProfile: (
    resolved: { cdpHost: string; cdpIsLoopback: boolean; profiles?: Record<string, unknown> },
    profileName: string,
  ) => {
    const profile = resolved.profiles?.[profileName] as {
      cdpPort?: number;
      cdpUrl?: string;
      color?: string;
    };
    if (typeof profile?.cdpPort !== "number") {
      return null;
    }
    return {
      name: profileName,
      cdpPort: profile.cdpPort,
      cdpUrl: profile.cdpUrl ?? `http://${resolved.cdpHost}:${profile.cdpPort}`,
      cdpHost: resolved.cdpHost,
      cdpIsLoopback: resolved.cdpIsLoopback,
      color: profile.color ?? "#FF4500",
      driver: "openclaw",
      attachOnly: true,
    };
  },
}));

async function loadFreshBrowserModulesForTest() {
  vi.resetModules();
  ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
  ({ ensureSandboxBrowser } = await import("./browser.js"));
}

function buildConfig(noVncEnabled: boolean): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: true,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: false,
      noVncEnabled,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
    },
    tools: {
      allow: ["browser"],
      deny: [],
    },
    prune: {
      idleHours: 24,
      maxAgeDays: 7,
    },
  };
}

function computeTestBrowserHash(params: {
  cfg: SandboxConfig;
  createArgsEpoch: string;
  workspaceDir?: string;
  agentWorkspaceDir?: string;
  dockerEnvPolicyEpoch?: string;
}): string {
  const workspaceDir = params.workspaceDir ?? "/tmp/workspace";
  const agentWorkspaceDir = params.agentWorkspaceDir ?? workspaceDir;
  const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
    docker: params.cfg.docker,
    browser: params.cfg.browser,
  });
  return computeSandboxBrowserConfigHash({
    docker: browserDockerCfg,
    dockerEnvPolicyEpoch: params.dockerEnvPolicyEpoch,
    browser: {
      cdpPort: params.cfg.browser.cdpPort,
      cdpSourceRange: params.cfg.browser.cdpSourceRange,
      vncPort: params.cfg.browser.vncPort,
      noVncPort: params.cfg.browser.noVncPort,
      headless: params.cfg.browser.headless,
      noVncEnabled: params.cfg.browser.noVncEnabled,
      autoStartTimeoutMs: params.cfg.browser.autoStartTimeoutMs,
    },
    securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir,
    agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: params.createArgsEpoch,
    readOnlyWorkspaceSkillMounts: [],
  });
}

type EnsureSandboxBrowserParams = Parameters<typeof import("./browser.js").ensureSandboxBrowser>[0];

async function ensureTestSandboxBrowser(params: Omit<EnsureSandboxBrowserParams, "bridgeAuth">) {
  return await ensureSandboxBrowser({
    ...params,
    bridgeAuth: { token: "test-bridge-token" },
  });
}

function requireDockerCreateArgs(): string[] {
  const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
  if (!createArgs) {
    throw new Error("expected docker create args");
  }
  return createArgs;
}

function snapshotDockerCreateEnvEntries(args: string[]): string[] | undefined {
  const envFile = collectDockerFlagValues(args, "--env-file")[0];
  return envFile ? readFileSync(envFile, "utf8").split("\n").filter(Boolean) : undefined;
}

function requireDockerCreateEnvEntries(): string[] {
  if (!capturedDockerCreateEnvEntries) {
    throw new Error("expected the docker create environment file to exist during create");
  }
  return capturedDockerCreateEnvEntries;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function latestBridgeResolved(): Record<string, unknown> {
  const params = bridgeMocks.startBrowserBridgeServer.mock.calls.at(-1)?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("expected browser bridge start params");
  }
  const resolved = params.resolved;
  if (!resolved || typeof resolved !== "object") {
    throw new Error("expected resolved browser bridge config");
  }
  return resolved;
}

describe("ensureSandboxBrowser create args", () => {
  beforeAll(async () => {
    await loadFreshBrowserModulesForTest();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    BROWSER_BRIDGES.clear();
    dockerMocks.dockerContainerState.mockClear();
    dockerMocks.execDocker.mockClear();
    dockerMocks.readDockerContainerEnvVar.mockClear();
    dockerMocks.readDockerContainerLabel.mockClear();
    dockerMocks.readDockerPort.mockClear();
    registryMocks.readBrowserRegistry.mockClear();
    registryMocks.updateBrowserRegistry.mockClear();
    bridgeMocks.startBrowserBridgeServer.mockClear();
    bridgeMocks.stopBrowserBridgeServer.mockClear();
    runtimeMocks.log.mockClear();
    capturedDockerCreateEnvEntries = undefined;

    dockerMocks.dockerContainerState.mockResolvedValue({ exists: false, running: false });
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: `${SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "create") {
        capturedDockerCreateEnvEntries = snapshotDockerCreateEnvEntries(args);
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    dockerMocks.readDockerContainerLabel.mockResolvedValue(null);
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) => {
      if (port === 9222) {
        return 49100;
      }
      if (port === 6080) {
        return 49101;
      }
      return null;
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.updateBrowserRegistry.mockResolvedValue(undefined);
    bridgeMocks.startBrowserBridgeServer.mockResolvedValue({
      server: { listening: true } as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        server: null,
        port: 19000,
        resolved: { profiles: {} },
        profiles: new Map(),
      },
    });
    bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  it("rejects stale sandbox browser images without the relay auth contract", async () => {
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "<no value>\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow(
      "Sandbox browser image openclaw-sandbox-browser:bookworm-slim is stale or incompatible",
    );

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
  });

  it("keeps the browser Dockerfile contract label aligned with the runtime constant", () => {
    const dockerfile = readFileSync(
      new URL("../../../scripts/docker/sandbox/Dockerfile.browser", import.meta.url),
      "utf8",
    );
    const label = dockerfile.match(
      /^LABEL org\.openclaw\.sandbox-browser\.contract="([^"]+)"$/m,
    )?.[1];

    expect(label).toBe(SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH);
  });

  it("delivers configured browser and generated CDP/noVNC environment without exposing values in Docker argv", async () => {
    // noVNC password stays in the container environment; external access uses a
    // short-lived observer token so URLs do not carry the password.
    const configuredSentinel = "synthetic-browser-transport-value";
    const cfg = buildConfig(true);
    cfg.docker.env = { ...cfg.docker.env, BROWSER_TRANSPORT_SENTINEL: configuredSentinel };
    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = requireDockerCreateArgs();

    expect(createArgs.some((arg) => arg.includes(configuredSentinel))).toBe(false);
    expect(createArgs).toContain("127.0.0.1::6080");
    expect(collectDockerFlagValues(createArgs, "--env-file")).toHaveLength(1);
    expect(createArgs).not.toContain("-e");
    expect(createArgs).not.toContain("--env");
    const envEntries = requireDockerCreateEnvEntries();
    expect(envEntries).toContain(`BROWSER_TRANSPORT_SENTINEL=${configuredSentinel}`);
    expect(envEntries).toContain("OPENCLAW_BROWSER_NO_SANDBOX=1");
    const passwordEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="),
    );
    expect(passwordEntry).toMatch(/^OPENCLAW_BROWSER_NOVNC_PASSWORD=[A-Za-z0-9]{8}$/);
    const authEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_CDP_AUTH_TOKEN="),
    );
    expect(authEntry).toMatch(/^OPENCLAW_BROWSER_CDP_AUTH_TOKEN=[0-9a-f]{48}$/);
    const noVncPassword = requireValue(passwordEntry, "noVNC password env").slice(
      "OPENCLAW_BROWSER_NOVNC_PASSWORD=".length,
    );
    const cdpAuthToken = requireValue(authEntry, "CDP auth env").slice(
      "OPENCLAW_BROWSER_CDP_AUTH_TOKEN=".length,
    );
    expect(createArgs.some((arg) => arg.includes(noVncPassword))).toBe(false);
    expect(createArgs.some((arg) => arg.includes(cdpAuthToken))).toBe(false);
    expect(result?.noVncUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sandbox\/novnc\?token=/);
    expect(result?.noVncUrl).not.toContain("password=");
  });

  it("creates browser containers with Docker init and the shared args epoch", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const createArgs = requireDockerCreateArgs();
    expect(createArgs.filter((arg) => arg === "--init")).toHaveLength(1);
    expect(createArgs).toContain(`openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`);
  });

  it("serializes concurrent provisioning for the same browser container", async () => {
    let created = false;
    let cdpAuthToken: string | undefined;
    let configHash: string | undefined;
    dockerMocks.dockerContainerState.mockImplementation(async () => ({
      exists: created,
      running: created,
    }));
    dockerMocks.readDockerContainerEnvVar.mockImplementation(async (_containerName, key) =>
      key === "OPENCLAW_BROWSER_CDP_AUTH_TOKEN" ? (cdpAuthToken ?? null) : null,
    );
    dockerMocks.readDockerContainerLabel.mockImplementation(async () => configHash ?? null);
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: `${SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "create") {
        if (created) {
          throw new Error("docker name conflict");
        }
        created = true;
        const envEntries = requireValue(
          snapshotDockerCreateEnvEntries(args),
          "docker create environment file",
        );
        cdpAuthToken = envEntries
          .find((entry) => entry.startsWith("OPENCLAW_BROWSER_CDP_AUTH_TOKEN="))
          ?.slice("OPENCLAW_BROWSER_CDP_AUTH_TOKEN=".length);
        configHash = collectDockerFlagValues(args, "--label")
          .find((entry) => entry.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length);
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const params = {
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    };
    await expect(
      Promise.all([ensureTestSandboxBrowser(params), ensureTestSandboxBrowser(params)]),
    ).resolves.toHaveLength(2);

    expect(dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(
      1,
    );
    expect(dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === "start")).toHaveLength(
      1,
    );
  });

  it("recreates a cold browser container when the shared args epoch changes", async () => {
    const cfg = buildConfig(false);
    const oldHash = computeTestBrowserHash({
      cfg,
      createArgsEpoch: "pre-init",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue(oldHash);
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-browser-session-test-0661d10a",
          sessionKey: "session:test",
          createdAtMs: 1,
          lastUsedAtMs: 0,
          image: cfg.browser.image,
          configHash: oldHash,
          cdpPort: 49100,
        },
      ],
    });
    BROWSER_BRIDGES.set("session:test", {
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      bridge: { server: { listening: true } },
    });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
      { allowFailure: true },
    );
    const rmCallIndex = dockerMocks.execDocker.mock.calls.findIndex(([args]) => args[0] === "rm");
    expect(bridgeMocks.stopBrowserBridgeServer.mock.invocationCallOrder[0]).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[rmCallIndex] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(requireDockerCreateArgs()).toContain("--init");
  });

  it("keeps a hot pre-init browser running and emits the recreate hint", async () => {
    const cfg = buildConfig(false);
    const oldHash = computeTestBrowserHash({
      cfg,
      createArgsEpoch: "pre-init",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue(oldHash);
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-browser-session-test-0661d10a",
          sessionKey: "session:test",
          createdAtMs: 1,
          lastUsedAtMs: Date.now(),
          image: cfg.browser.image,
          configHash: oldHash,
          cdpPort: 49100,
        },
      ],
    });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "rm")).toBeUndefined();
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
    expect(runtimeMocks.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Recreate to apply: openclaw sandbox recreate --browser --session session:test",
      ),
    );
    expect(registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[0]?.configHash).toBe(oldHash);
  });

  it("does not inject noVNC password env when noVNC is disabled", async () => {
    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const envEntries = requireDockerCreateEnvEntries();
    expect(
      envEntries.filter((entry) => entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD=")),
    ).toStrictEqual([]);
    expect(result?.noVncUrl).toBeUndefined();
  });

  it("skips browser user binds that conflict with protected skill overlay container paths", async () => {
    // Protected skill overlays are authoritative; a browser bind targeting the same
    // container path is skipped so the read-only skill overlay wins and Docker does
    // not reject the container with a "Duplicate mount point" error.
    const workspaceDir = tempDirs.make("openclaw-browser-mounts-");
    const customRoot = tempDirs.make("openclaw-browser-mounts-");
    mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    cfg.docker.dangerouslyAllowReservedContainerTargets = true;
    cfg.browser.binds = [`${customRoot}:/workspace/skills:rw`];

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg,
    });

    const bindArgs = collectDockerFlagValues(requireDockerCreateArgs(), "-v");
    const workspaceMountIdx = bindArgs.indexOf(`${workspaceDir}:/workspace:z`);
    const customMount = `${customRoot}:/workspace/skills:rw`;
    const protectedMount = `${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`;
    const protectedMountIdx = bindArgs.indexOf(protectedMount);

    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    // User bind is skipped because it conflicts with the protected skill overlay
    expect(bindArgs).not.toContain(customMount);
    // Protected skill overlay is present and appended after user binds
    expect(protectedMountIdx).toBeGreaterThan(workspaceMountIdx);
    expect(runtimeMocks.log).toHaveBeenCalledWith(
      expect.stringContaining(`skipping user bind "${customMount}"`),
    );
  });

  it("includes the explicit env policy epoch in the browser config hash when needed", async () => {
    const cfg = buildConfig(false);
    cfg.docker.env = {
      LANG: "C.UTF-8",
      GEMINI_API_KEY: "dummy-gemini",
    };
    const scopeKey = "session-1";
    const workspaceDir = "/tmp/workspace";
    const agentWorkspaceDir = "/tmp/workspace";
    const expectedHash = computeTestBrowserHash({
      cfg,
      dockerEnvPolicyEpoch: SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
      workspaceDir,
      agentWorkspaceDir,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    });

    await ensureTestSandboxBrowser({
      scopeKey,
      workspaceDir,
      agentWorkspaceDir,
      cfg,
    });

    const createArgs = requireDockerCreateArgs();
    expect(createArgs).toContain(`openclaw.configHash=${expectedHash}`);
    expect(requireDockerCreateEnvEntries()).toContain("GEMINI_API_KEY=dummy-gemini");
    expect(createArgs.some((arg) => arg.includes("dummy-gemini"))).toBe(false);
  });

  it("fails before creating a browser container when Docker daemon is unavailable", async () => {
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          stdout: "",
          stderr:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
          code: 1,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow("Docker daemon is not available");

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
  });

  it("passes the browser SSRF policy to the sandbox bridge", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    expect(latestBridgeResolved().ssrfPolicy).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
  });

  it("recreates a cached bridge when the SSRF policy changes", async () => {
    const existingBridge = {
      server: { listening: true } as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: true,
          controlPort: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18899,
          extensionRelayDefaultPort: 18799,
          extensionRelayPorts: {},
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          localLaunchTimeoutMs: 15_000,
          localCdpReadyTimeoutMs: 8_000,
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "openclaw",
          extraArgs: [],
          tabCleanup: {
            enabled: true,
            idleMinutes: 120,
            maxTabsPerSession: 8,
            sweepMinutes: 5,
          },
          profiles: {
            openclaw: {
              cdpPort: 49100,
              color: "#FF4500",
            },
          },
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    };
    BROWSER_BRIDGES.set("session:test", {
      bridge: existingBridge,
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      authToken: "test-bridge-token",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      ssrfPolicy: { allowedHostnames: ["example.com"] },
    });

    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledWith(existingBridge.server);
    expect(latestBridgeResolved().ssrfPolicy).toEqual({
      allowedHostnames: ["example.com"],
    });
  });

  it("recreates a cached bridge when evaluate permission changes", async () => {
    const existingBridge = {
      server: { listening: true } as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: true,
          controlPort: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18899,
          extensionRelayDefaultPort: 18799,
          extensionRelayPorts: {},
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          localLaunchTimeoutMs: 15_000,
          localCdpReadyTimeoutMs: 8_000,
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "openclaw",
          extraArgs: [],
          tabCleanup: {
            enabled: true,
            idleMinutes: 120,
            maxTabsPerSession: 8,
            sweepMinutes: 5,
          },
          profiles: {
            openclaw: {
              cdpPort: 49100,
              color: "#FF4500",
            },
          },
        },
      },
    };
    BROWSER_BRIDGES.set("session:test", {
      bridge: existingBridge,
      containerName: "openclaw-sbx-browser-session-test-0661d10a",
      authToken: "test-bridge-token",
    });
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
      evaluateEnabled: false,
    });

    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledWith(existingBridge.server);
    expect(latestBridgeResolved().evaluateEnabled).toBe(false);
  });

  it("mounts the main workspace read-only when workspaceAccess is none", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "none";

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = requireDockerCreateArgs();

    expect(createArgs).toContain("/tmp/workspace:/workspace:ro,z");
  });

  it("keeps the main workspace writable when workspaceAccess is rw", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = requireDockerCreateArgs();

    expect(createArgs).toContain("/tmp/workspace:/workspace:z");
    expect(createArgs).not.toContain("/tmp/workspace:/workspace:ro,z");
  });

  it("stamps the mount format version label on browser containers", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const labels = collectDockerFlagValues(createArgs ?? [], "--label");
    expect(labels).toContain(`openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`);
  });

  it("force-removes the browser container when CDP never becomes reachable", async () => {
    // A browser container that starts but never exposes CDP is unusable; remove
    // it immediately so the next attempt recreates from a clean state.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
      await params.onEnsureAttachTarget?.({});
      return {
        server: {} as never,
        port: 19000,
        baseUrl: "http://127.0.0.1:19000",
        state: {
          server: null,
          port: 19000,
          resolved: { profiles: {} },
          profiles: new Map(),
        },
      };
    });

    const cfg = buildConfig(false);
    cfg.browser.autoStartTimeoutMs = 1;

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow("hung container has been forcefully removed");

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
      { allowFailure: true },
    );
  });

  it.each([200, 503])(
    "cancels the CDP probe response body after a %i startup probe",
    async (status) => {
      const cancels: Array<ReturnType<typeof vi.fn>> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        cancels.push(cancel);
        return {
          ok: status === 200,
          body: { cancel },
        } as never;
      });
      bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
        await params.onEnsureAttachTarget?.({});
        throw new Error("probe completed before bridge creation");
      });

      const cfg = buildConfig(false);
      cfg.browser.autoStartTimeoutMs = 50;

      await expect(
        ensureTestSandboxBrowser({
          scopeKey: "session:test",
          workspaceDir: "/tmp/workspace",
          agentWorkspaceDir: "/tmp/workspace",
          cfg,
        }),
      ).rejects.toThrow(
        status === 200
          ? "probe completed before bridge creation"
          : "hung container has been forcefully removed",
      );

      expect(cancels).not.toHaveLength(0);
      for (const cancel of cancels) {
        expect(cancel).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps a stalled CDP request inside the browser startup deadline", async () => {
    const sockets = new Set<Socket>();
    let requestPath: string | undefined;
    let resolveRequestReceived: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequestReceived = resolve;
    });
    const server = createServer((req, _res) => {
      requestPath = req.url;
      req.resume();
      resolveRequestReceived?.();
      // Accept the CDP request but never send response headers.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const cdpPort = (server.address() as AddressInfo).port;
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) => {
      if (port === 9222) {
        return cdpPort;
      }
      if (port === 6080) {
        return 49101;
      }
      return null;
    });
    bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
      await params.onEnsureAttachTarget?.({});
      throw new Error("expected CDP startup to time out before bridge creation");
    });

    const cfg = buildConfig(false);
    cfg.browser.autoStartTimeoutMs = 250;

    try {
      const startup = ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      });
      const startupResult = startup.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await Promise.race([
        requestReceived,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("CDP request was not received")), 2_000).unref();
        }),
      ]);

      expect(requestPath).toBe("/json/version");
      const result = await startupResult;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected stalled CDP startup to fail");
      }
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        `within ${cfg.browser.autoStartTimeoutMs}ms. The hung container has been forcefully removed.`,
      );
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("requires auth for the sandbox CDP relay without auto-derived source ranges", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const envEntries = requireDockerCreateEnvEntries();
    const authEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_CDP_AUTH_TOKEN="),
    );
    expect(authEntry).toMatch(/^OPENCLAW_BROWSER_CDP_AUTH_TOKEN=[0-9a-f]{48}$/);
    expect(envEntries).not.toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=172.21.0.1/32");

    const token = requireValue(authEntry, "CDP auth env").slice(
      "OPENCLAW_BROWSER_CDP_AUTH_TOKEN=".length,
    );
    const profiles = latestBridgeResolved().profiles as Record<
      string,
      { cdpPort?: number; cdpUrl?: string }
    >;
    expect(profiles.openclaw?.cdpPort).toBe(49100);
    expect(profiles.openclaw?.cdpUrl).toBe(`http://openclaw:${token}@127.0.0.1:49100`);
  });

  it("passes explicit cdpSourceRange as an additional relay filter", async () => {
    const cfg = buildConfig(false);
    cfg.browser.cdpSourceRange = "10.0.0.0/24";

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const envEntries = requireDockerCreateEnvEntries();
    expect(envEntries).toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=10.0.0.0/24");
  });

  it("recreates existing browser containers that do not expose relay auth", async () => {
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    expect(dockerMocks.execDocker).toHaveBeenCalledWith(
      ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
      { allowFailure: true },
    );
    requireDockerCreateArgs();
  });

  it("retains a stale container and cached bridge until bridge cleanup can retry", async () => {
    const containerName = "openclaw-sbx-browser-session-test-0661d10a";
    const cached = {
      containerName,
      bridge: { server: { listening: true } },
    };
    BROWSER_BRIDGES.set("session:test", cached);
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow("bridge cleanup failed");

    expect(BROWSER_BRIDGES.get("session:test")).toBe(cached);
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "rm")).toBeUndefined();

    bridgeMocks.stopBrowserBridgeServer.mockClear();
    dockerMocks.execDocker.mockClear();
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const rmCallIndex = dockerMocks.execDocker.mock.calls.findIndex(([args]) => args[0] === "rm");
    expect(bridgeMocks.stopBrowserBridgeServer.mock.invocationCallOrder[0]).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[rmCallIndex] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(BROWSER_BRIDGES.get("session:test")).not.toBe(cached);
  });

  it("rejects network=none before Docker inspection or browser bridge startup", async () => {
    const cfg = buildConfig(false);
    cfg.browser.network = "none";

    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(
      'Sandbox browser network mode "none" is unsupported because browser control requires a host-reachable published CDP port.',
    );
    expect(dockerMocks.dockerContainerState).not.toHaveBeenCalled();
    expect(dockerMocks.execDocker).not.toHaveBeenCalled();
    expect(dockerMocks.readDockerPort).not.toHaveBeenCalled();
    expect(bridgeMocks.startBrowserBridgeServer).not.toHaveBeenCalled();
  });
});
