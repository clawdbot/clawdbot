// Docker backend manager tests cover runtime image matching and removal error
// handling for sandbox and browser containers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";

const dockerMocks = vi.hoisted(() => ({
  containerState: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  execContainer: vi.fn(),
  execContainerRaw: vi.fn(),
  resolvePodmanSandboxRuntimeInfo: vi.fn(),
  validateSandboxContainerEngineTarget: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    containerState: dockerMocks.containerState,
    ensureSandboxContainer: dockerMocks.ensureSandboxContainer,
    execContainer: dockerMocks.execContainer,
    execContainerRaw: dockerMocks.execContainerRaw,
    resolvePodmanSandboxRuntimeInfo: dockerMocks.resolvePodmanSandboxRuntimeInfo,
    validateSandboxContainerEngineTarget: dockerMocks.validateSandboxContainerEngineTarget,
  };
});

const {
  createDockerSandboxBackend,
  createPodmanSandboxBackend,
  dockerSandboxBackendManager,
  podmanSandboxBackendManager,
} = await import("./docker-backend.js");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "none",
          docker: {
            image: "openclaw-sandbox:bookworm-slim",
          },
          browser: {
            enabled: true,
            image: "openclaw-sandbox-browser:bookworm-slim",
          },
        },
      },
      list: [],
    },
  };
}

function createConflictingSharedConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "shared",
          workspaceAccess: "rw",
        },
      },
      entries: {
        alpha: { workspace: "/tmp/openclaw-alpha" },
        beta: { workspace: "/tmp/openclaw-beta" },
      },
    },
  };
}

describe("docker sandbox backend manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.containerState.mockResolvedValue({
      exists: true,
      running: true,
    });
    dockerMocks.execContainer.mockResolvedValue({
      code: 0,
      stdout: "unused-image",
      stderr: "",
    });
    dockerMocks.resolvePodmanSandboxRuntimeInfo.mockResolvedValue({
      machine: false,
      rootless: true,
      target: { key: "local", globalArgs: [] },
    });
  });

  it("forwards the canonical scope key to container provisioning", async () => {
    dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-container");
    const scopeKey = `agent:poly:workspace:${"a".repeat(32)}`;

    await createDockerSandboxBackend({
      sessionKey: "agent:poly:msteams:channel-1",
      scopeKey,
      workspaceDir: "/tmp/customer/workspace",
      agentWorkspaceDir: "/tmp/customer/workspace",
      cfg: resolveSandboxConfigForAgent(createConfig(), "poly"),
      newRuntimeBlockReason: "incompatible shared mounts",
    });

    expect(dockerMocks.ensureSandboxContainer).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey, newRuntimeBlockReason: "incompatible shared mounts" }),
    );
  });

  it("binds Podman provisioning and later execs to the resolved target", async () => {
    dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-podman");
    const podmanTarget = {
      key: `machine:${"a".repeat(32)}`,
      globalArgs: [
        "--url",
        "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock",
        "--identity",
        "/tmp/podman-machine-key",
      ],
    };
    dockerMocks.resolvePodmanSandboxRuntimeInfo.mockResolvedValueOnce({
      machine: true,
      rootless: true,
      target: podmanTarget,
    });
    const config = createConfig();
    config.agents!.defaults!.sandbox!.backend = "podman";
    config.agents!.defaults!.sandbox!.browser!.enabled = false;

    const backend = await createPodmanSandboxBackend({
      sessionKey: "agent:coder:main",
      scopeKey: "agent:coder:main",
      workspaceDir: "/workspace",
      agentWorkspaceDir: "/workspace",
      cfg: resolveSandboxConfigForAgent(config),
    });
    const execSpec = await backend.buildExecSpec({
      command: "true",
      env: {},
      usePty: false,
    });

    expect(dockerMocks.ensureSandboxContainer).toHaveBeenCalledWith(
      expect.objectContaining({ podmanTarget }),
    );
    expect(dockerMocks.validateSandboxContainerEngineTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman" }),
      podmanTarget,
    );
    expect(execSpec.argv.slice(0, 6)).toEqual(["podman", ...podmanTarget.globalArgs, "exec"]);
  });

  it("matches ordinary sandbox runtimes against sandbox.docker.image", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-1",
        backendId: "docker",
        runtimeLabel: "sandbox-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
        configLabelKind: "Image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("matches browser runtimes against sandbox.browser.image", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox-browser:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "browser-1",
        backendId: "docker",
        runtimeLabel: "browser-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
        configLabelKind: "BrowserImage",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox-browser:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("defaults docker-backed runtime matching to sandbox.docker.image when label kind is missing", async () => {
    // Older registry entries did not record configLabelKind; keep ordinary
    // sandbox matching stable for those existing containers.
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-legacy",
        backendId: "docker",
        runtimeLabel: "sandbox-legacy",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("reports Docker runtime removal failures", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "permission denied",
    });

    await expect(
      dockerSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "sandbox-1",
          backendId: "docker",
          runtimeLabel: "sandbox-1",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).rejects.toThrow("Failed to remove Docker sandbox runtime sandbox-1: permission denied");
  });

  it("treats already-missing Docker runtimes as removed", async () => {
    // Prune/remove flows are idempotent; Docker may have already removed the
    // container by the time the manager runs.
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "Error response from daemon: No such container: sandbox-1",
    });

    await expect(
      dockerSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "sandbox-1",
          backendId: "docker",
          runtimeLabel: "sandbox-1",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses to remove a grandfathered shared runtime before config recovery", async () => {
    await expect(
      dockerSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "oc-shared",
          backendId: "docker",
          runtimeLabel: "oc-shared",
          sessionKey: "shared",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConflictingSharedConfig(),
      }),
    ).rejects.toThrow("Refusing to remove grandfathered shared sandbox runtime oc-shared");

    expect(dockerMocks.execContainer).not.toHaveBeenCalled();
  });

  it("uses Podman for Podman registry entries", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await podmanSandboxBackendManager.removeRuntime({
      entry: {
        containerName: "sandbox-podman",
        backendId: "podman",
        backendTarget: { key: "local", globalArgs: [] },
        runtimeLabel: "sandbox-podman",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:bookworm-slim",
      },
      config: createConfig(),
    });

    expect(dockerMocks.execContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman", command: "podman" }),
      ["rm", "-f", "sandbox-podman"],
      { allowFailure: true },
    );
    expect(dockerMocks.validateSandboxContainerEngineTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman", command: "podman" }),
      { key: "local", globalArgs: [] },
    );
  });

  it("rejects a stale Podman registry target before inspecting the runtime", async () => {
    const targetError = new Error("active Podman connection changed");
    dockerMocks.validateSandboxContainerEngineTarget.mockRejectedValueOnce(targetError);

    await expect(
      podmanSandboxBackendManager.describeRuntime({
        entry: {
          containerName: "sandbox-podman",
          backendId: "podman",
          backendTarget: {
            key: `machine:${"a".repeat(32)}`,
            globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
          },
          runtimeLabel: "sandbox-podman",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).rejects.toBe(targetError);

    expect(dockerMocks.containerState).not.toHaveBeenCalled();
    expect(dockerMocks.execContainer).not.toHaveBeenCalled();
  });

  it("rejects a stale Podman registry target before removing the runtime", async () => {
    const targetError = new Error("active Podman connection changed");
    dockerMocks.validateSandboxContainerEngineTarget.mockRejectedValueOnce(targetError);

    await expect(
      podmanSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "sandbox-podman",
          backendId: "podman",
          backendTarget: {
            key: `machine:${"a".repeat(32)}`,
            globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
          },
          runtimeLabel: "sandbox-podman",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).rejects.toBe(targetError);

    expect(dockerMocks.execContainer).not.toHaveBeenCalled();
  });

  it("rejects browser sandboxing on the explicit Podman backend", async () => {
    const config = createConfig();
    config.agents!.defaults!.sandbox!.backend = "podman";
    await expect(
      createPodmanSandboxBackend({
        sessionKey: "agent:coder:main",
        scopeKey: "agent:coder:main",
        workspaceDir: "/workspace",
        agentWorkspaceDir: "/workspace",
        skillsWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
        cfg: resolveSandboxConfigForAgent(config),
      }),
    ).rejects.toThrow(
      "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
    );

    expect(dockerMocks.ensureSandboxContainer).not.toHaveBeenCalled();
  });

  it("matches canonical Podman image identity when Podman expands a short name", async () => {
    dockerMocks.execContainer
      .mockResolvedValueOnce({
        code: 0,
        stdout: "localhost/openclaw-sandbox:bookworm-slim\tsha256:abc123\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "abc123\n",
        stderr: "",
      });

    const result = await podmanSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-podman",
        backendId: "podman",
        backendTarget: { key: "local", globalArgs: [] },
        runtimeLabel: "sandbox-podman",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:bookworm-slim",
        configLabelKind: "Image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "localhost/openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
    expect(dockerMocks.execContainer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "podman", command: "podman" }),
      ["image", "inspect", "-f", "{{.Id}}", "openclaw-sandbox:bookworm-slim"],
      { allowFailure: true },
    );
  });
});
