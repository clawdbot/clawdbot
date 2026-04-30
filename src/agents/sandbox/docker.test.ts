import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";

type SpawnCall = {
  command: string;
  args: string[];
};

type MockDockerChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (input?: string | Buffer) => void };
  kill: (signal?: NodeJS.Signals) => void;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  imageExists: true,
  inspectError: "",
}));

function createMockDockerChild(): MockDockerChild {
  const child = new EventEmitter() as MockDockerChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: () => undefined };
  child.kill = () => undefined;
  return child;
}

function spawnDockerProcess(command: string, args: string[]) {
  spawnState.calls.push({ command, args });
  const child = createMockDockerChild();

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
  } else if (args[0] === "pull" || args[0] === "tag") {
    code = 0;
  } else {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }

  queueMicrotask(() => {
    if (stderr) {
      child.stderr.emit("data", Buffer.from(stderr));
    }
    child.emit("close", code);
  });
  return child;
}

async function createChildProcessMock() {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnDockerProcess,
  };
}

vi.mock("node:child_process", async () => createChildProcessMock());

let ensureDockerImage: typeof import("./docker.js").ensureDockerImage;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("node:child_process", async () => createChildProcessMock());
  ({ ensureDockerImage } = await import("./docker.js"));
}

describe("ensureDockerImage", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.imageExists = true;
    spawnState.inspectError = "";
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
