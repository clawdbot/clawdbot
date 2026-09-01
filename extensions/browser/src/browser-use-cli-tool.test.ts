import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import {
  BrowserHarnessInstallError,
  ensureManagedBrowserHarness,
  prepareManagedBrowserUseCliRuntime,
  resolveManagedBrowserHarnessPaths,
} from "./browser-use-cli-install.js";
import { createBrowserUseCliTool, type BrowserUseCliRuntime } from "./browser-use-cli-tool.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function completed(stdout = "ok") {
  return {
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("managed Browser Harness install", () => {
  it("installs an exact Browser Harness into OpenClaw-owned state", async () => {
    const stateDir = tempDirs.make("oc-bh-managed-install-");
    const paths = resolveManagedBrowserHarnessPaths(stateDir);
    let installed = false;
    const runCommand = vi.fn(async (argv: string[], _options: unknown) => {
      if (argv[1] === "--version") {
        return installed ? completed("0.1.10\n") : { ...completed(), code: 1 };
      }
      expect(argv).toContain("browser-harness==0.1.10");
      expect(argv).toContain("--managed-python");
      for (const requirement of [
        "anyio==4.14.2",
        "cdp-use==1.4.5",
        "certifi==2026.7.22",
        "fetch-use==0.4.0",
        "h11==0.16.0",
        "httpcore==1.0.9",
        "httpx==0.28.1",
        "idna==3.19",
        "pillow==12.3.0",
        "typing-extensions==4.16.0",
        "websockets==15.0.1",
      ]) {
        expect(argv).toContain(requirement);
      }
      installed = true;
      await fs.writeFile(paths.executable, "fixture", { mode: 0o755 });
      return completed();
    });

    await expect(
      ensureManagedBrowserHarness({
        stateDir,
        deps: {
          ensureUv: async () => path.join(stateDir, "uv"),
          runCommand: runCommand as never,
        },
      }),
    ).resolves.toBe(paths.executable);
    expect(runCommand).toHaveBeenCalledTimes(3);
    const installOptions = runCommand.mock.calls[1]?.[1] as unknown as {
      baseEnv?: NodeJS.ProcessEnv;
      env?: NodeJS.ProcessEnv;
    };
    expect(installOptions.baseEnv).toEqual({});
    expect(installOptions.env).toMatchObject({
      BH_TELEMETRY: "0",
      BROWSER_HARNESS_TELEMETRY: "0",
      BH_RECORD: "0",
      UV_TOOL_DIR: paths.toolDir,
      UV_TOOL_BIN_DIR: paths.binDir,
      UV_PYTHON_INSTALL_DIR: paths.pythonDir,
      UV_MANAGED_PYTHON: "1",
    });
    expect(installOptions.env).not.toHaveProperty("BROWSER_USE_API_KEY");
  });

  it("retries a transient managed install failure on the next call", async () => {
    const stateDir = tempDirs.make("oc-bh-managed-failure-");
    const paths = resolveManagedBrowserHarnessPaths(stateDir);
    let installAttempts = 0;
    let installed = false;
    const runCommand = vi.fn(async (argv: string[]) => {
      if (argv[1] === "--version") {
        return installed ? completed("0.1.10\n") : { ...completed(), code: 1 };
      }
      installAttempts += 1;
      if (installAttempts === 1) {
        return { ...completed(), code: 2, stderr: "offline" };
      }
      installed = true;
      await fs.writeFile(paths.executable, "fixture", { mode: 0o755 });
      return completed();
    });
    const install = () =>
      ensureManagedBrowserHarness({
        stateDir,
        deps: {
          ensureUv: async () => path.join(stateDir, "uv"),
          runCommand: runCommand as never,
        },
      });

    await expect(install()).rejects.toBeInstanceOf(BrowserHarnessInstallError);
    await expect(install()).resolves.toBe(paths.executable);
    expect(installAttempts).toBe(2);
  });
});

describe("Browser Use CLI tool", () => {
  async function createFixture(kind: BrowserUseCliRuntime["kind"] = "managed") {
    const workspaceDir = tempDirs.make("oc-bu-cli-test-");
    const stateDir = tempDirs.make("oc-bu-cli-state-");
    const managed = prepareManagedBrowserUseCliRuntime({ stateDir });
    if (!managed) {
      throw new Error("expected this test platform to support managed Browser Harness");
    }
    const runtime: BrowserUseCliRuntime =
      kind === "managed"
        ? managed
        : {
            kind: "orchestrator",
            executable: "/trusted/bin/browser-harness",
            pathEnv: "/trusted/bin:/usr/bin",
            lang: "C.UTF-8",
            runtimeDir: path.join(stateDir, "runtime"),
            daemonName: "eval_browser",
          };
    const runCommand = vi.fn(async (argv: string[], options: { input?: string }) => {
      if (argv[1] === "--version") {
        return completed("0.1.10\n");
      }
      const code = options.input ?? "";
      const screenshotPath = /capture_screenshot\(("[^"]+")/.exec(code)?.[1];
      if (screenshotPath) {
        await fs.writeFile(JSON.parse(screenshotPath) as string, tinyPng);
      }
      return completed();
    });
    const tool = createBrowserUseCliTool({
      runtime,
      workspaceDir,
      runCommand: runCommand as never,
      ensureManaged: async () => "/managed/bin/browser-harness",
    });
    return { runCommand, runtime, tool, workspaceDir };
  }

  it("starts the normal managed daemon with a clean telemetry-disabled environment", async () => {
    const { runCommand, runtime, tool, workspaceDir } = await createFixture();

    const result = await tool.execute("start-1", { action: "start" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("normal daemon"),
    });
    const [argv, options] = runCommand.mock.calls[0] as unknown as [
      string[],
      { cwd?: string; input?: string; baseEnv?: NodeJS.ProcessEnv; env?: NodeJS.ProcessEnv },
    ];
    expect(argv).toEqual(["/managed/bin/browser-harness"]);
    expect(options.cwd).toBe(workspaceDir);
    expect(options.input).toBe("list_tabs()\n");
    expect(options.baseEnv).toEqual({});
    expect(options.env).toMatchObject({
      BH_TELEMETRY: "0",
      BROWSER_HARNESS_TELEMETRY: "0",
      BH_RECORD: "0",
      BH_RUNTIME_DIR: runtime.runtimeDir,
      BU_NAME: "openclaw",
    });
    expect(options.env).not.toHaveProperty("BH_REQUIRE_EXISTING_DAEMON");
    expect(options.env).not.toHaveProperty("BROWSER_USE_API_KEY");
  });

  it("keeps the evaluator's existing daemon contract", async () => {
    const { runCommand, tool } = await createFixture("orchestrator");

    await expect(tool.execute("status-1", { action: "status" })).resolves.toMatchObject({
      details: { action: "status", orchestratorOwned: true },
    });
    const options = runCommand.mock.calls[0]?.[1] as unknown as { env?: NodeJS.ProcessEnv };
    expect(options.env).toMatchObject({ BH_REQUIRE_EXISTING_DAEMON: "1" });
    expect(runCommand.mock.calls[1]?.[1]).toMatchObject({ input: "list_tabs()\n" });
  });

  it("rejects an old orchestrator CLI asynchronously before daemon I/O", async () => {
    const { runCommand, tool } = await createFixture("orchestrator");
    runCommand.mockResolvedValue(completed("0.1.9\n"));

    await expect(tool.execute("status-old", { action: "status" })).resolves.toMatchObject({
      details: { action: "status", status: "failed", version: "unsupported" },
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]?.[0]).toEqual(["/trusted/bin/browser-harness", "--version"]);
  });

  it("uses Browser Harness helpers and retains screenshots", async () => {
    const { runCommand, tool, workspaceDir } = await createFixture();

    await tool.execute("open-1", { action: "open", url: "https://8.8.8.8/?q='quoted'" });
    const openOptions = runCommand.mock.calls[0]?.[1] as unknown as { input?: string };
    expect(openOptions.input).toContain("new_tab(");
    const result = await tool.execute("shot-1", { action: "screenshot", fullPage: true });
    expect(result.content.some((block) => block.type === "image")).toBe(true);
    const files = await fs.readdir(path.join(workspaceDir, ".openclaw", "browser"));
    expect(files).toHaveLength(1);
  });

  it("rejects protected navigation before Browser Harness I/O", async () => {
    const { runCommand, tool } = await createFixture();

    await expect(
      tool.execute("open-file", { action: "open", url: "file:///etc/passwd" }),
    ).rejects.toThrow('Navigation blocked: unsupported protocol "file:"');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("stops only an OpenClaw-owned managed daemon", async () => {
    const { runCommand, tool } = await createFixture();

    await tool.execute("stop-1", { action: "stop" });

    expect(runCommand.mock.calls[0]?.[0]).toEqual(["/managed/bin/browser-harness", "--reload"]);
  });
});
