// Container-engine timeout tests cover the typed fail-closed error for a
// wedged engine and back-compat for calls that request no timeout.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_PROVISION_TIMEOUT_MS } from "./constants.js";
import type { SandboxConfig } from "./types.js";

type SpawnOptions = { timeout?: number };

const spawnState = vi.hoisted(() => ({
  lastOptions: undefined as SpawnOptions | undefined,
  wedged: false,
  result: undefined as Record<string, unknown> | undefined,
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

function timedOutSpawnResult(): Record<string, unknown> {
  return {
    failed: true,
    timedOut: true,
    isCanceled: false,
    isTerminated: true,
    signal: "SIGTERM",
    exitCode: undefined,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
}

async function spawnContainerEngineProcess(_argv: string[], options?: SpawnOptions) {
  spawnState.lastOptions = options;
  if (spawnState.result) {
    return spawnState.result;
  }
  if (spawnState.wedged) {
    // Mirrors verified execa behavior: with a timeout the promise settles as
    // timedOut; without one a wedged engine never settles (a test hang).
    if (typeof options?.timeout === "number") {
      return timedOutSpawnResult();
    }
    return await new Promise(() => {});
  }
  return {
    failed: false,
    timedOut: false,
    isCanceled: false,
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnContainerEngineProcess,
}));

vi.mock("./registry.js", () => ({
  readRegistryEntry: registryMocks.readRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
  updateRegistry: registryMocks.updateRegistry,
}));

let DOCKER_SANDBOX_ENGINE: typeof import("./container-engine.js").DOCKER_SANDBOX_ENGINE;
let execContainerRaw: typeof import("./container-engine.js").execContainerRaw;
let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;

// Shards run with --isolate=false, so a shared worker may already hold an
// unmocked module graph; re-import through vi.doMock like the sibling suites.
async function loadFreshContainerEngineForTest() {
  vi.resetModules();
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnContainerEngineProcess,
  }));
  vi.doMock("./registry.js", () => ({
    readRegistryEntry: registryMocks.readRegistryEntry,
    removeRegistryEntry: registryMocks.removeRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  ({ DOCKER_SANDBOX_ENGINE, execContainerRaw } = await import("./container-engine.js"));
  ({ ensureSandboxContainer } = await import("./docker.js"));
}

function wedgedSandboxConfig(): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess: "rw",
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-wedged-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none",
      capDrop: ["ALL"],
      env: {},
      dns: [],
      extraHosts: [],
      binds: [],
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "bridge",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

beforeEach(async () => {
  spawnState.lastOptions = undefined;
  spawnState.wedged = false;
  spawnState.result = undefined;
  registryMocks.readRegistryEntry.mockReset();
  registryMocks.removeRegistryEntry.mockReset();
  registryMocks.updateRegistry.mockReset();
  await loadFreshContainerEngineForTest();
});

// Later files share this worker under --isolate=false; leave no doMock behind.
afterAll(() => {
  vi.doUnmock("../../process/exec.js");
  vi.doUnmock("./registry.js");
  vi.resetModules();
});

describe("execContainerRaw timeout", () => {
  it("fails closed with a typed error when the engine hits the timeout", async () => {
    spawnState.result = timedOutSpawnResult();

    const error = await execContainerRaw(
      DOCKER_SANDBOX_ENGINE,
      ["inspect", "-f", "{{.State.Running}}", "oc-test"],
      { timeoutMs: 60_000 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const typed = error as Error & { code?: string };
    expect(typed.code).toBe("SANDBOX_CONTAINER_TIMEOUT");
    expect(typed.message).toContain("Docker did not respond within 60000ms");
    expect(typed.message).toContain("docker inspect -f");
    expect(typed.message).toContain("agents.defaults.sandbox.mode=off");
  });

  it("prefers the abort error when a timed-out result is also canceled", async () => {
    spawnState.result = { ...timedOutSpawnResult(), isCanceled: true };

    const error = await execContainerRaw(DOCKER_SANDBOX_ENGINE, ["version"], {
      timeoutMs: 60_000,
    }).catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("AbortError");
  });

  it("passes the timeout through to the spawn layer and keeps success untouched", async () => {
    const result = await execContainerRaw(DOCKER_SANDBOX_ENGINE, ["version"], {
      timeoutMs: 1234,
    });

    expect(result.code).toBe(0);
    expect(spawnState.lastOptions?.timeout).toBe(1234);
  });

  it("does not enable a spawn timeout when no timeoutMs is requested", async () => {
    await execContainerRaw(DOCKER_SANDBOX_ENGINE, ["version"]);

    expect(spawnState.lastOptions?.timeout).toBeUndefined();
  });
});

describe("ensureSandboxContainer with a wedged engine", () => {
  it("fails fast with the typed timeout on the first inspect instead of hanging", async () => {
    spawnState.wedged = true;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const error = await ensureSandboxContainer({
      scopeKey: "shared",
      workspaceDir: "/tmp/openclaw-wedged-test",
      agentWorkspaceDir: "/tmp/openclaw-wedged-test",
      cfg: wedgedSandboxConfig(),
    }).catch((caught: unknown) => caught);

    expect((error as Error & { code?: string }).code).toBe("SANDBOX_CONTAINER_TIMEOUT");
    expect(spawnState.lastOptions?.timeout).toBe(DEFAULT_SANDBOX_PROVISION_TIMEOUT_MS);
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
  }, 10_000);
});
