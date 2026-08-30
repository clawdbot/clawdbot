// Docker image tests cover sandbox image inspection and actionable setup errors
// without invoking a real Docker daemon.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

type SpawnCall = {
  command: string;
  args: string[];
};

type SpawnCallOptions = {
  maxBuffer?: number;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  imageExists: true,
  inspectError: "",
  infoAvailable: { docker: false, podman: false },
  podmanConnections: "[]\n",
  podmanInfo: "true\tfalse\t\t5.0.0\n",
  podmanMachines: "[]\n",
  lastOptions: undefined as SpawnCallOptions | undefined,
  executionError: undefined as Error | undefined,
  transportFailure: false,
  transportExitCode: 0,
  plainExitWithoutStderr: false,
}));

async function spawnDockerProcess(commandAndArgs: string[], options?: SpawnCallOptions) {
  const [command = "", ...args] = commandAndArgs;
  spawnState.calls.push({ command, args });
  spawnState.lastOptions = options;
  if (spawnState.executionError) {
    throw spawnState.executionError;
  }
  if (spawnState.transportFailure) {
    return Object.assign(new Error("docker stream failed"), {
      cause: new Error("docker stream failed"),
      failed: true,
      isCanceled: false,
      exitCode: spawnState.transportExitCode,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  }
  if (spawnState.plainExitWithoutStderr) {
    return {
      failed: true,
      isCanceled: false,
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker" && command !== "podman") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (command === "podman" && args[0] === "system") {
    stdout = spawnState.podmanConnections;
  } else if (command === "podman" && args[0] === "machine") {
    stdout = spawnState.podmanMachines;
  } else if (args[0] === "info") {
    code = spawnState.infoAvailable[command as "docker" | "podman"] ? 0 : 1;
    if (code === 0 && command === "podman" && args.includes("--format")) {
      stdout = spawnState.podmanInfo;
    }
    stderr = code === 0 ? "" : `${command} unavailable`;
  } else if (args[0] === "image" && args[1] === "inspect") {
    code = spawnState.imageExists ? 0 : 1;
    stderr = spawnState.imageExists
      ? ""
      : spawnState.inspectError || `Error response from daemon: No such image: ${args[2]}`;
  } else if (args[0] !== "pull" && args[0] !== "tag") {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

let ensureDockerImage: typeof import("./docker.js").ensureDockerImage;
let ensureContainerImage: typeof import("./docker.js").ensureContainerImage;
let execDockerRaw: typeof import("./docker.js").execDockerRaw;
let podmanSandboxEngine: typeof import("./docker.js").PODMAN_SANDBOX_ENGINE;
let resolvePodmanSandboxRuntimeInfo: typeof import("./docker.js").resolvePodmanSandboxRuntimeInfo;
let validateSandboxContainerEngineTarget: typeof import("./docker.js").validateSandboxContainerEngineTarget;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  const dockerModule = await import("./docker.js");
  ({ ensureContainerImage, ensureDockerImage, execDockerRaw } = dockerModule);
  resolvePodmanSandboxRuntimeInfo = dockerModule.resolvePodmanSandboxRuntimeInfo;
  validateSandboxContainerEngineTarget = dockerModule.validateSandboxContainerEngineTarget;
  podmanSandboxEngine = dockerModule.PODMAN_SANDBOX_ENGINE;
});

afterAll(() => {
  vi.doUnmock("../../process/exec.js");
  vi.resetModules();
});

beforeEach(() => {
  // Hoisted fault state survives module resets and must not reach the next case.
  spawnState.calls.length = 0;
  spawnState.imageExists = true;
  spawnState.inspectError = "";
  spawnState.infoAvailable.docker = false;
  spawnState.infoAvailable.podman = false;
  spawnState.podmanConnections = "[]\n";
  spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
  spawnState.podmanMachines = "[]\n";
  spawnState.lastOptions = undefined;
  spawnState.executionError = undefined;
  spawnState.transportFailure = false;
  spawnState.transportExitCode = 0;
  spawnState.plainExitWithoutStderr = false;
});

describe("resolvePodmanSandboxRuntimeInfo", () => {
  beforeEach(() => {
    spawnState.infoAvailable.podman = true;
  });

  it("rejects an arbitrary remote Podman connection", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
      /active Podman connection is remote/u,
    );
  });

  it("allows Podman Machine connections", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
        Identity: "/tmp/podman-machine-default",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-default",
        Running: true,
        IdentityPath: "/tmp/podman-machine-default",
        Port: 60000,
        RemoteUsername: "core",
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: true,
      rootless: true,
      version: "5.0.0",
      target: {
        key: expect.stringMatching(/^machine:[a-f0-9]{32}$/u),
        globalArgs: [
          "--url",
          "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
          "--identity",
          "/tmp/podman-machine-default",
        ],
      },
    });
  });

  it("allows rootful Podman Machine connections", async () => {
    spawnState.podmanInfo = "false\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default-root",
        URI: "ssh://root@127.0.0.1:60000/run/podman/podman.sock",
        Identity: "/tmp/podman-machine-default",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-default",
        Running: true,
        IdentityPath: "/tmp/podman-machine-default",
        Port: 60000,
        RemoteUsername: "core",
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
      machine: true,
      rootless: false,
      target: {
        globalArgs: [
          "--url",
          "ssh://root@127.0.0.1:60000/run/podman/podman.sock",
          "--identity",
          "/tmp/podman-machine-default",
        ],
      },
    });
  });

  it("rejects an unknown configured remote connection", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
        Default: true,
      },
    ]);

    await withEnvAsync({ CONTAINER_CONNECTION: "missing", CONTAINER_HOST: undefined }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(/could not be identified/u);
    });
  });

  it("prefers a configured host URI over a configured connection name", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
      },
    ]);

    await withEnvAsync(
      {
        CONTAINER_CONNECTION: "podman-machine-default",
        CONTAINER_HOST: "ssh://192.0.2.1:60000/run/user/1000/podman/podman.sock",
      },
      async () => {
        spawnState.podmanMachines = JSON.stringify([
          {
            Name: "podman-machine-default",
            Running: true,
            IdentityPath: "/tmp/podman-machine-default",
            Port: 60000,
            RemoteUsername: "core",
          },
        ]);
        await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
          /active Podman connection is remote/u,
        );
      },
    );
  });

  it("validates a named remote connection when the configured host URI is empty", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
      },
    ]);

    await withEnvAsync({ CONTAINER_CONNECTION: "remote", CONTAINER_HOST: "  " }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
        /active Podman connection is remote/u,
      );
    });
  });

  it("uses Podman's local Unix fallback when no connection is configured", async () => {
    spawnState.podmanInfo = "true\ttrue\t/run/user/1000/podman/podman.sock\t5.0.0\n";

    await withEnvAsync({ CONTAINER_CONNECTION: undefined, CONTAINER_HOST: undefined }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
        machine: false,
        rootless: true,
        version: "5.0.0",
        target: {
          key: expect.stringMatching(/^socket:[a-f0-9]{32}$/u),
          globalArgs: ["--url", "unix:///run/user/1000/podman/podman.sock"],
        },
      });
    });
  });

  it("revalidates the active Podman connection on every resolution", async () => {
    spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: false,
      rootless: true,
      version: "5.0.0",
      target: { key: "local", globalArgs: [] },
    });

    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
      /active Podman connection is remote/u,
    );
  });

  it("ignores a saved remote default while the CLI uses its local engine", async () => {
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "saved-remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: false,
      rootless: true,
      version: "5.0.0",
      target: { key: "local", globalArgs: [] },
    });
    expect(spawnState.calls.some((call) => call.args[0] === "system")).toBe(false);
  });

  it("rejects a different allowed Podman Machine after a runtime target is recorded", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-first",
        URI: "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock",
        Identity: "/tmp/first-machine-key",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-first",
        Running: true,
        IdentityPath: "/tmp/first-machine-key",
        Port: 60001,
        RemoteUsername: "core",
      },
    ]);
    const first = await resolvePodmanSandboxRuntimeInfo();

    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-second",
        URI: "ssh://core@127.0.0.1:60002/run/user/501/podman/podman.sock",
        Identity: "/tmp/second-machine-key",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-second",
        Running: true,
        IdentityPath: "/tmp/second-machine-key",
        Port: 60002,
        RemoteUsername: "core",
      },
    ]);

    await expect(
      validateSandboxContainerEngineTarget(podmanSandboxEngine, first.target),
    ).rejects.toThrow(/active Podman connection changed/u);
  });
});

describe("ensureDockerImage", () => {
  it("returns when the configured image already exists", async () => {
    await ensureDockerImage(DEFAULT_SANDBOX_IMAGE);

    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("does not satisfy the missing default sandbox image by tagging plain Debian", async () => {
    // The default image carries Python/helper contracts; tagging a base distro
    // would pass image inspection but fail sandbox file operations later.
    spawnState.imageExists = false;

    let err: unknown;
    try {
      await ensureDockerImage(DEFAULT_SANDBOX_IMAGE);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `Sandbox image not found: ${DEFAULT_SANDBOX_IMAGE}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("gives Podman users a Podman build command for the missing default image", async () => {
    spawnState.imageExists = false;

    await expect(ensureContainerImage(podmanSandboxEngine, DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      `podman build -t ${DEFAULT_SANDBOX_IMAGE} -f scripts/docker/sandbox/Dockerfile .`,
    );

    expect(spawnState.calls).toEqual([
      {
        command: "podman",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("throws when the Docker daemon is unavailable during image inspection", async () => {
    spawnState.imageExists = false;
    spawnState.inspectError =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

    await expect(ensureDockerImage(DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      "Docker daemon is not available",
    );

    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("preserves the Docker error for other image inspection failures", async () => {
    spawnState.imageExists = false;
    spawnState.inspectError = "permission denied";

    await expect(ensureDockerImage(DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      "Failed to inspect sandbox image: permission denied",
    );
  });

  it("preserves the Docker error for a missing custom image", async () => {
    spawnState.imageExists = false;

    await expect(ensureDockerImage("example/custom:latest")).rejects.toThrow(
      "Sandbox image not found: example/custom:latest. Build or pull it first.",
    );
  });
});

describe("execDockerRaw", () => {
  it("preserves canonical wrapper execution errors", async () => {
    spawnState.executionError = new Error("docker execution failed");

    await expect(
      execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE], { allowFailure: true }),
    ).rejects.toThrow("docker execution failed");
  });

  it("applies the sandbox output cap explicitly", async () => {
    await execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE]);

    expect(spawnState.lastOptions?.maxBuffer).toBe(SANDBOX_COMMAND_MAX_BUFFER_BYTES);
  });

  it("rejects transport failures even when Docker exits zero", async () => {
    spawnState.transportFailure = true;

    await expect(execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });

  it("rejects transport failures even when Docker exits nonzero", async () => {
    spawnState.transportFailure = true;
    spawnState.transportExitCode = 7;

    await expect(execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });

  it("does not include raw container arguments when stderr is empty", async () => {
    spawnState.plainExitWithoutStderr = true;
    const secret = "sandbox-secret-value";

    const error = await execDockerRaw(["create", "--env", `TOKEN=${secret}`]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Docker command failed (exit 1)");
    expect((error as Error).message).not.toContain(secret);
  });
});
