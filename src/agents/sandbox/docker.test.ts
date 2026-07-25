// Docker image tests cover sandbox image inspection and actionable setup errors
// without invoking a real Docker daemon.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  lastOptions: undefined as SpawnCallOptions | undefined,
  executionError: undefined as Error | undefined,
  transportFailure: false,
  transportExitCode: 0,
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

  let code = 0;
  let stderr = "";
  if (command !== "docker") {
    code = 1;
    stderr = `unexpected command: ${command}`;
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
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

let ensureDockerImage: typeof import("./docker.js").ensureDockerImage;
let execDockerRaw: typeof import("./docker.js").execDockerRaw;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  ({ ensureDockerImage, execDockerRaw } = await import("./docker.js"));
}

describe("ensureDockerImage", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.imageExists = true;
    spawnState.inspectError = "";
    spawnState.lastOptions = undefined;
    spawnState.executionError = undefined;
    spawnState.transportFailure = false;
    spawnState.transportExitCode = 0;
    await loadFreshDockerModuleForTest();
  });

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
    expect((err as Error).message).toContain("scripts/sandbox-setup.sh");
    expect((err as Error).message).toContain("python3");
    expect(spawnState.calls).toEqual([
      {
        command: "docker",
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
});

describe("execDockerRaw", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.imageExists = true;
    spawnState.inspectError = "";
    spawnState.lastOptions = undefined;
    spawnState.executionError = undefined;
    spawnState.transportFailure = false;
    spawnState.transportExitCode = 0;
    await loadFreshDockerModuleForTest();
  });

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
});
