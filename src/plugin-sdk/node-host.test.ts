import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { resolveNodeHostExecutable } from "./node-host.js";

const tempDirs: string[] = [];

async function createNpmShimPair(executable: string) {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-node-host-${executable}-`));
  tempDirs.push(binDir);
  const barePath = path.join(binDir, executable);
  const commandPath = path.join(binDir, `${executable}.cmd`);
  await fs.writeFile(barePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.writeFile(commandPath, "@echo off\r\nexit /b 0\r\n", "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(barePath, 0o755);
  }
  return { barePath, binDir, commandPath };
}

async function createBareNativeHost(executable: string) {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-node-host-${executable}-`));
  tempDirs.push(binDir);
  const barePath = path.join(binDir, executable);
  await fs.copyFile(process.execPath, barePath);
  return { barePath, binDir };
}

afterEach(async () => {
  clearExecutablePathCache();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveNodeHostExecutable", () => {
  it.runIf(process.platform === "win32").each([
    ["codex", "fallback"],
    ["claude", "prefer"],
    ["opencode", "fallback"],
    ["pi", "direct"],
  ] as const)(
    "selects the Windows npm launcher for the %s catalog",
    async (executable, strategy) => {
      const { binDir, commandPath } = await createNpmShimPair(executable);

      expect(
        resolveNodeHostExecutable(executable, {
          env: { PATH: binDir, PATHEXT: ".CMD" },
          pathEnv: binDir,
          strategy,
        }),
      ).toEqual({ executable: commandPath });
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves an explicit extensionless Windows override",
    async () => {
      const { barePath, binDir } = await createNpmShimPair("custom-host");

      expect(
        resolveNodeHostExecutable("custom-host", {
          env: { PATH: binDir, PATHEXT: ".CMD" },
          includeExtensionless: true,
          pathEnv: binDir,
          strategy: "direct",
        }),
      ).toEqual({ executable: barePath });
    },
  );

  it.runIf(process.platform === "win32").each([["direct"], ["fallback"], ["prefer"]] as const)(
    "falls back to a bare-only Windows host for %s",
    async (strategy) => {
      const { barePath, binDir } = await createBareNativeHost(`bare-${strategy}`);

      const resolution = resolveNodeHostExecutable(`bare-${strategy}`, {
        env: { PATH: binDir, PATHEXT: ".CMD;.EXE" },
        pathEnv: binDir,
        strategy,
      });

      expect(resolution).toEqual({ executable: barePath });
    },
  );

  it.runIf(process.platform === "win32").each([["direct"], ["fallback"], ["prefer"]] as const)(
    "prefers a later Windows PATHEXT launcher over an earlier bare shim for %s",
    async (strategy) => {
      const { binDir: bareDir } = await createBareNativeHost(`later-${strategy}`);
      const { binDir: launcherDir, commandPath } = await createNpmShimPair(`later-${strategy}`);
      const pathEnv = `${bareDir};${launcherDir}`;

      expect(
        resolveNodeHostExecutable(`later-${strategy}`, {
          env: { PATH: pathEnv, PATHEXT: ".CMD" },
          pathEnv,
          strategy,
        }),
      ).toEqual({ executable: commandPath });
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves an explicit PATHEXT-only Windows override",
    async () => {
      const { binDir } = await createBareNativeHost("suffix-only-host");

      expect(
        resolveNodeHostExecutable("suffix-only-host", {
          env: { PATH: binDir, PATHEXT: ".CMD" },
          includeExtensionless: false,
          pathEnv: binDir,
          strategy: "direct",
        }),
      ).toBeUndefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps the extensionless npm launcher on POSIX",
    async () => {
      const { barePath, binDir } = await createNpmShimPair("codex");

      expect(
        resolveNodeHostExecutable("codex", {
          env: { PATH: binDir },
          pathEnv: binDir,
          strategy: "direct",
        }),
      ).toEqual({ executable: barePath });
    },
  );
});
