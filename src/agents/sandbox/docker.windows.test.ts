// Docker Windows invocation tests cover safe docker executable resolution
// without shelling through wrapper scripts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resolveDockerSpawnInvocation } from "./docker.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-docker-spawn-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("resolveDockerSpawnInvocation", () => {
  it("keeps non-windows invocation unchanged", () => {
    const resolved = resolveDockerSpawnInvocation(["version"], {
      platform: "darwin",
      env: {},
      execPath: "/usr/bin/node",
    });
    expect(resolved).toEqual({
      command: "docker",
      args: ["version"],
      shell: undefined,
      windowsHide: undefined,
    });
  });

  it("prefers docker.exe entrypoint over cmd shell fallback on windows", async () => {
    const dir = await createTempDir();
    const exePath = path.join(dir, "docker.exe");
    const cmdPath = path.join(dir, "docker.cmd");
    await writeFile(exePath, "", "utf8");
    await writeFile(cmdPath, `@ECHO off\r\n"%~dp0\\docker.exe" %*\r\n`, "utf8");

    const resolved = resolveDockerSpawnInvocation(["version"], {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: exePath,
      args: ["version"],
      shell: undefined,
      windowsHide: true,
    });
  });

  it("rejects unresolved docker.cmd wrappers instead of shelling out", async () => {
    // Shell fallback would reinterpret docker args on Windows; require a real
    // executable or Node entrypoint instead.
    const dir = await createTempDir();
    const cmdPath = path.join(dir, "docker.cmd");
    await mkdir(path.dirname(cmdPath), { recursive: true });
    await writeFile(cmdPath, "@ECHO off\r\necho docker\r\n", "utf8");

    expect(() =>
      resolveDockerSpawnInvocation(["ps"], {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
      }),
    ).toThrow(
      /wrapper resolved, but no executable\/Node entrypoint could be resolved without shell execution\./i,
    );
  });
});
