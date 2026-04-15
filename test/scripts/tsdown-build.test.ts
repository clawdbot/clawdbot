import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pruneSourceCheckoutBundledPluginNodeModules,
  pruneStaleRootChunkFiles,
  resolveTsdownBuildInvocation,
} from "../../scripts/tsdown-build.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("resolveTsdownBuildInvocation", () => {
  it("routes Windows tsdown builds through the pnpm runner instead of shell=true", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: {},
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
        "exec",
        "tsdown",
        "--config-loader",
        "unrun",
        "--logLevel",
        "warn",
      ],
      options: {
        encoding: "utf8",
        stdio: "pipe",
        shell: false,
        windowsVerbatimArguments: undefined,
        env: {},
      },
    });
  });

  it("keeps source-checkout prune best-effort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.spyOn(fs, "rmSync");

    rmSync.mockImplementation(() => {
      throw new Error("locked");
    });

    expect(() =>
      pruneSourceCheckoutBundledPluginNodeModules({
        cwd: process.cwd(),
      }),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      "tsdown: could not prune bundled plugin source node_modules: Error: locked",
    );

    warn.mockRestore();
    rmSync.mockRestore();
  });

  it("prunes stale hashed root chunk files but keeps stable aliases and nested assets", async () => {
    const rootDir = createTempDir("openclaw-tsdown-build-");
    const distDir = path.join(rootDir, "dist");
    const distRuntimeDir = path.join(rootDir, "dist-runtime");
    await fsPromises.mkdir(path.join(distDir, "control-ui"), { recursive: true });
    await fsPromises.mkdir(distRuntimeDir, { recursive: true });
    await fsPromises.writeFile(path.join(distDir, "delegate-BPjCe4gC.js"), "old delegate\n");
    await fsPromises.writeFile(path.join(distDir, "compact.runtime-2DiEmVcA.js"), "old runtime\n");
    await fsPromises.writeFile(path.join(distDir, "compact.runtime.js"), "stable alias\n");
    await fsPromises.writeFile(path.join(distDir, "entry.js"), "entry\n");
    await fsPromises.writeFile(path.join(distDir, "control-ui", "index.html"), "asset\n");
    await fsPromises.writeFile(
      path.join(distRuntimeDir, "heartbeat-runner.runtime-fspOEj_1.js"),
      "old runtime\n",
    );
    await fsPromises.writeFile(path.join(distRuntimeDir, "heartbeat-runner.runtime.js"), "alias\n");

    pruneStaleRootChunkFiles({ cwd: rootDir });

    await expect(
      fsPromises.readFile(path.join(distDir, "compact.runtime.js"), "utf8"),
    ).resolves.toBe("stable alias\n");
    await expect(fsPromises.readFile(path.join(distDir, "entry.js"), "utf8")).resolves.toBe(
      "entry\n",
    );
    await expect(
      fsPromises.readFile(path.join(distDir, "control-ui", "index.html"), "utf8"),
    ).resolves.toBe("asset\n");
    await expect(
      fsPromises.readFile(path.join(distRuntimeDir, "heartbeat-runner.runtime.js"), "utf8"),
    ).resolves.toBe("alias\n");
    await expect(fsPromises.stat(path.join(distDir, "delegate-BPjCe4gC.js"))).rejects.toThrow();
    await expect(
      fsPromises.stat(path.join(distDir, "compact.runtime-2DiEmVcA.js")),
    ).rejects.toThrow();
    await expect(
      fsPromises.stat(path.join(distRuntimeDir, "heartbeat-runner.runtime-fspOEj_1.js")),
    ).rejects.toThrow();
  });
});
