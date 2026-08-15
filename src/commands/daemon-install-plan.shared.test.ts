// Daemon install plan tests cover shared install plan validation and platform warning helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
  resolveDaemonServicePathDirs,
} from "./daemon-install-plan.shared.js";

describe("resolveDaemonInstallRuntimeInputs", () => {
  it("detects src ts entrypoints when devMode is not overridden", async () => {
    const originalArgv = process.argv;
    try {
      for (const [entrypoint, expected] of [
        ["/Users/me/openclaw/src/cli/index.ts", true],
        ["C:\\Users\\me\\openclaw\\src\\cli\\index.ts", true],
        ["/Users/me/openclaw/dist/cli/index.js", false],
      ] as const) {
        process.argv = ["node", entrypoint];
        await expect(
          resolveDaemonInstallRuntimeInputs({
            env: {},
            runtime: "node",
            nodePath: "/custom/node",
          }),
        ).resolves.toMatchObject({ devMode: expected });
      }
    } finally {
      process.argv = originalArgv;
    }
  });

  it("keeps explicit devMode and nodePath overrides", async () => {
    await expect(
      resolveDaemonInstallRuntimeInputs({
        env: {},
        runtime: "node",
        devMode: false,
        nodePath: "/custom/node",
      }),
    ).resolves.toEqual({
      devMode: false,
      nodePath: "/custom/node",
    });
  });
});

describe("resolveDaemonNodeBinDir", () => {
  it("returns the absolute node bin directory", () => {
    expect(resolveDaemonNodeBinDir("/custom/node/bin/node")).toEqual(["/custom/node/bin"]);
  });

  it("ignores bare executable names", () => {
    expect(resolveDaemonNodeBinDir("node")).toBeUndefined();
  });
});

describe("resolveDaemonServicePathDirs openclaw discovery", () => {
  it("uses the active openclaw command directory", () => {
    expect(
      resolveDaemonServicePathDirs({
        argv: ["node", "/Users/testuser/.npm-global/bin/openclaw", "gateway", "install"],
        env: { PATH: "" },
        platform: "darwin",
      }),
    ).toEqual(["/Users/testuser/.npm-global/bin"]);
  });

  it.skipIf(process.platform === "win32")(
    "finds the PATH shim that resolves to the active package entrypoint",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-path-"));
      try {
        const binDir = path.join(root, "bin");
        const packageDir = path.join(root, "lib", "node_modules", "openclaw");
        const entrypoint = path.join(packageDir, "openclaw.mjs");
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(entrypoint, "");
        fs.symlinkSync(entrypoint, path.join(binDir, "openclaw"));

        expect(
          resolveDaemonServicePathDirs({
            argv: ["node", entrypoint, "gateway", "install"],
            env: { PATH: binDir },
            platform: "darwin",
          }),
        ).toEqual([binDir]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "ignores unrelated openclaw commands elsewhere on PATH",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-path-"));
      try {
        const binDir = path.join(root, "bin");
        const activeEntrypoint = path.join(root, "active", "openclaw.mjs");
        const otherEntrypoint = path.join(root, "other", "openclaw.mjs");
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(path.dirname(activeEntrypoint), { recursive: true });
        fs.mkdirSync(path.dirname(otherEntrypoint), { recursive: true });
        fs.writeFileSync(activeEntrypoint, "");
        fs.writeFileSync(otherEntrypoint, "");
        fs.symlinkSync(otherEntrypoint, path.join(binDir, "openclaw"));

        expect(
          resolveDaemonServicePathDirs({
            argv: ["node", activeEntrypoint, "gateway", "install"],
            env: { PATH: binDir },
            platform: "darwin",
          }),
        ).toBeUndefined();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("resolveDaemonServicePathDirs", () => {
  it("combines node and active openclaw command directories", () => {
    expect(
      resolveDaemonServicePathDirs({
        nodePath: "/opt/homebrew/opt/node/bin/node",
        argv: ["node", "/Users/testuser/.npm-global/bin/openclaw", "gateway", "install"],
        env: { PATH: "" },
        platform: "darwin",
      }),
    ).toEqual(["/opt/homebrew/opt/node/bin", "/Users/testuser/.npm-global/bin"]);
  });
});
