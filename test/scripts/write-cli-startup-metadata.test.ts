// Write Cli Startup Metadata tests cover write cli startup metadata script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";
import { __testing, writeCliStartupMetadata } from "../../scripts/write-cli-startup-metadata.ts";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

// These subprocess tests use explicit ready/close signals; timeout only catches broken fixtures.
const LOAD_SENSITIVE_PROCESS_TIMEOUT_MS = process.env.CI ? 30_000 : 15_000;

function writeFixtureFile(rootDir: string, relativePath: string, contents: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function writeStartupMetadataSourceSignatureFixture(rootDir: string): void {
  const fixtures = new Map<string, string>([
    ["extensions/browser/src/cli/browser-cli.ts", "export const browserHelp = 'browser';\n"],
    ["extensions/canvas/cli-metadata.ts", "export const canvasMetadata = 'canvas';\n"],
    ["extensions/canvas/index.ts", "export const canvasEntry = 'canvas';\n"],
    ["extensions/canvas/src/a2ui-jsonl.ts", "export const a2uiJsonl = 'canvas';\n"],
    ["extensions/canvas/src/cli-helpers.ts", "export const canvasHelpers = 'canvas';\n"],
    ["extensions/canvas/src/cli.ts", "export const canvasCliHelp = 'canvas';\n"],
    ["src/cli/banner.ts", "export const banner = 'openclaw';\n"],
    [
      "src/cli/daemon-cli/register-service-commands.ts",
      "export const gatewayServiceCommands = 'gateway';\n",
    ],
    ["src/cli/gateway-cli.ts", "export const gatewayHelp = 'gateway';\n"],
    ["src/cli/gateway-cli/register.ts", "export const gatewayRegister = 'gateway';\n"],
    ["src/cli/gateway-cli/run-command.ts", "export const gatewayRun = 'gateway';\n"],
    ["src/cli/help-format.ts", "export const helpFormat = 'help';\n"],
    ["src/cli/models-cli.ts", "export const modelsHelp = 'models';\n"],
    ["src/cli/nodes-cli/register.ts", "export const nodesHelp = 'nodes';\n"],
    ["src/cli/program/register.maintenance.ts", "export const maintenanceHelp = 'maintenance';\n"],
    [
      "src/cli/program/register.status-health-sessions.ts",
      "export const statusHealthSessionsHelp = 'sessions';\n",
    ],
    ["src/cli/program/context.ts", "export const context = 'context';\n"],
    ["src/cli/program/help.ts", "export const help = 'help';\n"],
    ["src/cli/plugins-cli.ts", "export const pluginsHelp = 'plugins';\n"],
    [
      "src/plugins/register-plugin-cli-command-groups.ts",
      "export const pluginCommandGroups = 'plugins';\n",
    ],
    ["src/cli/secrets-cli.ts", "export const secretsHelp = 'secrets';\n"],
    ["packages/terminal-core/src/links.ts", "export const links = 'links';\n"],
    ["packages/terminal-core/src/theme.ts", "export const theme = 'theme';\n"],
  ]);
  for (const [relativePath, contents] of fixtures) {
    writeFixtureFile(rootDir, relativePath, contents);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function createSpawnTextChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  });
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`process ${pid} was still alive after ${timeoutMs}ms`);
}

async function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("write-cli-startup-metadata", () => {
  const { createTempDir } = createScriptTestHarness();

  it("hard-kills synchronous source root help after its timeout", () => {
    const spawnSyncMock = vi.mocked(spawnSync);
    const successfulRender = {
      error: undefined,
      output: [null, "Usage: openclaw\n", ""],
      pid: 123,
      signal: null,
      status: 0,
      stderr: "",
      stdout: "Usage: openclaw\n",
    };
    spawnSyncMock.mockReturnValueOnce(successfulRender);

    expect(__testing.renderSourceRootHelpText()).toBe("Usage: openclaw\n");

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({
      killSignal: "SIGKILL",
      timeout: 120_000,
    });
  });

  it("fails command help rendering when captured output exceeds the byte limit", async () => {
    await expect(
      __testing.spawnText(["--eval", "process.stdout.write('x'.repeat(2048))"], {
        cwd: process.cwd(),
        env: process.env,
        failureMessage: "render failed",
        killGraceMs: 25,
        maxOutputBytes: 1024,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("render failed: output exceeded 1024 bytes");
  });

  it.each(["stdout", "stderr"] as const)(
    "fails command help rendering when %s emits a stream error",
    async (streamName) => {
      const child = createSpawnTextChild();
      const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>);
      const streamError = new Error(`${streamName} pipe failed`);

      const render = __testing.spawnText(["--help"], {
        cwd: process.cwd(),
        env: process.env,
        failureMessage: "render failed",
        killGraceMs: 25,
        maxOutputBytes: 1024,
        spawnProcess: spawnProcess as typeof spawn,
        timeoutMs: 5_000,
      });

      child[streamName].emit("error", streamError);
      child.emit("close", null, "SIGTERM");

      await expect(render).rejects.toMatchObject({
        message: `render failed: ${streamName} read error: ${streamName} pipe failed`,
        cause: streamError,
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    },
  );

  it("preserves an output-limit failure when shutdown also errors a stream", async () => {
    const child = createSpawnTextChild();
    const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>);
    const render = __testing.spawnText(["--help"], {
      cwd: process.cwd(),
      env: process.env,
      failureMessage: "render failed",
      killGraceMs: 25,
      maxOutputBytes: 5,
      spawnProcess: spawnProcess as typeof spawn,
      timeoutMs: 5_000,
    });

    child.stdout.emit("data", "123456");
    child.stdout.emit("error", new Error("pipe closed during shutdown"));
    child.emit("close", null, "SIGTERM");

    await expect(render).rejects.toThrow("render failed: output exceeded 5 bytes");
  });

  it("signals Windows command help render process trees with taskkill", () => {
    const childKill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    __testing.signalCliStartupMetadataProcessTree({ pid: 123, kill: childKill }, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "123", "/T"], {
      stdio: "ignore",
    });

    __testing.signalCliStartupMetadataProcessTree({ pid: 123, kill: childKill }, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "123", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(childKill).not.toHaveBeenCalled();
  });

  it("force-kills Windows command help render process trees when graceful taskkill fails", () => {
    const childKill = vi.fn(() => true);
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    __testing.signalCliStartupMetadataProcessTree({ pid: 123, kill: childKill }, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "123", "/T"], {
      stdio: "ignore",
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "123", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(childKill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "kills descendant processes when command help rendering times out",
    async () => {
      const tempRoot = createTempDir("openclaw-startup-metadata-timeout-");
      const markerPath = path.join(tempRoot, "grandchild.pid");
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = await import('node:child_process');",
        "const { writeFileSync } = await import('node:fs');",
        `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(markerPath)}, String(grandchild.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expect(
        __testing.spawnText(["--input-type=module", "--eval", parentScript], {
          cwd: tempRoot,
          env: process.env,
          failureMessage: "render failed",
          killGraceMs: 25,
          maxOutputBytes: 1024,
          timeoutMs: 500,
        }),
      ).rejects.toThrow("render failed: timed out after 500ms");

      const grandchildPid = Number(readFileSync(markerPath, "utf8"));
      await waitForProcessExit(grandchildPid);
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for all command help descendants before re-raising parent signals",
    async () => {
      const tempRoot = createTempDir("openclaw-startup-metadata-signal-");
      const fastCommandPath = path.join(tempRoot, "fast-command.mjs");
      const fastReadyPath = path.join(tempRoot, "fast-ready");
      const commandPath = path.join(tempRoot, "command.mjs");
      const runnerPath = path.join(tempRoot, "runner.mjs");
      const grandchildPidPath = path.join(tempRoot, "grandchild.pid");
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      writeFixtureFile(
        tempRoot,
        "fast-command.mjs",
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(fastReadyPath)}, "ready");`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      writeFixtureFile(
        tempRoot,
        "command.mjs",
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(
            grandchildScript,
          )}], { stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      writeFixtureFile(
        tempRoot,
        "runner.mjs",
        [
          `const { __testing } = await import(${JSON.stringify(
            pathToFileURL(path.resolve("scripts/write-cli-startup-metadata.ts")).href,
          )});`,
          "void __testing.spawnText(",
          `  [${JSON.stringify(fastCommandPath)}],`,
          "  {",
          `    cwd: ${JSON.stringify(tempRoot)},`,
          "    env: process.env,",
          "    failureMessage: 'fast render failed',",
          "    killGraceMs: 100,",
          "    maxOutputBytes: 1024,",
          "    timeoutMs: 30_000,",
          "  },",
          ").catch(() => undefined);",
          "void __testing.spawnText(",
          `  [${JSON.stringify(commandPath)}],`,
          "  {",
          `    cwd: ${JSON.stringify(tempRoot)},`,
          "    env: process.env,",
          "    failureMessage: 'render failed',",
          "    killGraceMs: 100,",
          "    maxOutputBytes: 1024,",
          "    timeoutMs: 30_000,",
          "  },",
          ").catch(() => undefined);",
        ].join("\n"),
      );

      const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      let grandchildPid = 0;

      try {
        const deadline = Date.now() + LOAD_SENSITIVE_PROCESS_TIMEOUT_MS;
        while (Date.now() < deadline) {
          try {
            grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
          } catch {}
          let fastReady = false;
          try {
            fastReady = readFileSync(fastReadyPath, "utf8") === "ready";
          } catch {}
          if (fastReady && grandchildPid > 0 && processIsAlive(grandchildPid)) {
            break;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        expect(readFileSync(fastReadyPath, "utf8")).toBe("ready");
        expect(grandchildPid).toBeGreaterThan(0);
        expect(processIsAlive(grandchildPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForProcessExit(grandchildPid);
      } finally {
        if (runner.pid && processIsAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (grandchildPid > 0 && processIsAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
      }
    },
  );

  it("writes startup metadata with populated root help text when dist falls back to source rendering", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");

    mkdirSync(distDir, { recursive: true });
    mkdirSync(path.join(extensionsDir, "matrix"), { recursive: true });
    writeFileSync(
      path.join(extensionsDir, "matrix", "package.json"),
      JSON.stringify({
        openclaw: {
          channel: {
            id: "matrix",
            order: 120,
            label: "Matrix",
          },
        },
      }),
      "utf8",
    );

    await writeCliStartupMetadata({
      distDir,
      outputPath,
      extensionsDir,
      renderBundledRootHelpText: async () => {
        throw new Error("dist root help unavailable");
      },
      renderSourceRootHelpText: () => "Usage: openclaw\n",
      renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
      renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
      renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
      renderSourceSubcommandHelpTextRecord: () => ({
        doctor: "Usage: openclaw doctor\n",
        gateway: "Usage: openclaw gateway\n",
        models: "Usage: openclaw models\n",
        plugins: "Usage: openclaw plugins\n",
        sessions: "Usage: openclaw sessions\n",
        tasks: "Usage: openclaw tasks\n",
      }),
    });

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      browserHelpText: string;
      channelOptions: string[];
      generatorSignature: string;
      nodesHelpText: string;
      rootHelpText: string;
      secretsHelpText: string;
      subcommandHelpText: {
        doctor: string;
        gateway: string;
        models: string;
        plugins: string;
        sessions: string;
        tasks: string;
      };
    };
    expect(written.channelOptions).toContain("matrix");
    expect(written.generatorSignature).toMatch(/^[a-f0-9]{40}$/u);
    expect(written.browserHelpText).toContain("Usage:");
    expect(written.browserHelpText).toContain("openclaw browser");
    expect(written.secretsHelpText).toContain("Usage:");
    expect(written.secretsHelpText).toContain("openclaw secrets");
    expect(written.nodesHelpText).toContain("Usage:");
    expect(written.nodesHelpText).toContain("openclaw nodes");
    expect(written.rootHelpText).toContain("Usage:");
    expect(written.rootHelpText).toContain("openclaw");
    expect(written.subcommandHelpText.doctor).toContain("openclaw doctor");
    expect(written.subcommandHelpText.gateway).toContain("openclaw gateway");
    expect(written.subcommandHelpText.models).toContain("openclaw models");
    expect(written.subcommandHelpText.plugins).toContain("openclaw plugins");
    expect(written.subcommandHelpText.sessions).toContain("openclaw sessions");
    expect(written.subcommandHelpText.tasks).toContain("openclaw tasks");
  });

  it("renders independent startup help snapshots concurrently", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-concurrency-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    const started: string[] = [];
    const unblockers = new Map<string, () => void>();
    const expectedStarted = ["browser", "secrets", "nodes", "subcommands"];

    mkdirSync(distDir, { recursive: true });
    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const renderAfterUnblock = (label: string, output: string): (() => Promise<string>) => {
      return async () => {
        started.push(label);
        await new Promise<void>((resolve) => {
          unblockers.set(label, resolve);
        });
        return output;
      };
    };

    const waitForAllStarted = async (): Promise<void> => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        if (expectedStarted.every((label) => started.includes(label))) {
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      throw new Error(`startup help renderers did not start concurrently: ${started.join(", ")}`);
    };

    const writePromise = writeCliStartupMetadata({
      distDir,
      outputPath,
      extensionsDir,
      sourceRootDir: tempRoot,
      renderBundledRootHelpText: async () => "Usage: openclaw\n",
      renderSourceBrowserHelpText: renderAfterUnblock("browser", "Usage: openclaw browser\n"),
      renderSourceSecretsHelpText: renderAfterUnblock("secrets", "Usage: openclaw secrets\n"),
      renderSourceNodesHelpText: renderAfterUnblock("nodes", "Usage: openclaw nodes\n"),
      renderSourceSubcommandHelpTextRecord: async () => {
        started.push("subcommands");
        await new Promise<void>((resolve) => {
          unblockers.set("subcommands", resolve);
        });
        return {
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        };
      },
    });

    await waitForAllStarted();
    for (const label of expectedStarted) {
      unblockers.get(label)?.();
    }
    await writePromise;

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      browserHelpText: string;
      nodesHelpText: string;
      secretsHelpText: string;
    };
    expect(written.browserHelpText).toContain("openclaw browser");
    expect(written.secretsHelpText).toContain("openclaw secrets");
    expect(written.nodesHelpText).toContain("openclaw nodes");
  });

  it("regenerates nodes help when bundled canvas CLI help sources change", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-signature-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    let nodesRenderCount = 0;

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const writeMetadata = async (): Promise<void> => {
      await writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderBundledRootHelpText: async () => "Usage: openclaw\n",
        renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
        renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
        renderSourceNodesHelpText: () => {
          nodesRenderCount += 1;
          return `Usage: openclaw nodes ${nodesRenderCount}\n`;
        },
        renderSourceSubcommandHelpTextRecord: () => ({
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        }),
      });
    };

    await writeMetadata();
    await writeMetadata();
    expect(nodesRenderCount).toBe(1);

    const staleGeneratorMetadata = JSON.parse(readFileSync(outputPath, "utf8")) as Record<
      string,
      unknown
    >;
    staleGeneratorMetadata.generatorSignature = "stale-generator";
    writeFileSync(outputPath, `${JSON.stringify(staleGeneratorMetadata, null, 2)}\n`, "utf8");

    await writeMetadata();
    expect(nodesRenderCount).toBe(2);

    writeFixtureFile(
      tempRoot,
      "extensions/canvas/src/cli.ts",
      "export const canvasCliHelp = 'canvas changed help';\n",
    );

    await writeMetadata();

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      nodesHelpText: string;
    };
    expect(nodesRenderCount).toBe(3);
    expect(written.nodesHelpText).toContain("openclaw nodes 3");
  });

  it("regenerates help when build version or commit changes", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-build-identity-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    let renderCount = 0;
    let commandRenderCount = 0;

    const renderSubcommandHelp = () => {
      commandRenderCount += 1;
      const buildInfo = JSON.parse(readFileSync(path.join(distDir, "build-info.json"), "utf8")) as {
        commit: string;
        version: string;
      };
      const banner = `OpenClaw ${buildInfo.version} (${buildInfo.commit.slice(0, 7)})`;
      return {
        doctor: `${banner}\nUsage: openclaw doctor\n`,
        gateway: `${banner}\nUsage: openclaw gateway\n`,
        models: `${banner}\nUsage: openclaw models\n`,
        plugins: `${banner}\nUsage: openclaw plugins\n`,
        sessions: `${banner}\nUsage: openclaw sessions\n`,
        tasks: `${banner}\nUsage: openclaw tasks\n`,
      };
    };

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const writeMetadata = async (): Promise<void> => {
      await writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderBundledRootHelpText: async () => {
          renderCount += 1;
          return `Usage: openclaw ${renderCount}\n`;
        },
        renderSourceBrowserHelpText: () => {
          commandRenderCount += 1;
          return "Usage: openclaw browser\n";
        },
        renderSourceSecretsHelpText: () => {
          commandRenderCount += 1;
          return "Usage: openclaw secrets\n";
        },
        renderSourceNodesHelpText: () => {
          commandRenderCount += 1;
          return "Usage: openclaw nodes\n";
        },
        renderSourceSubcommandHelpTextRecord: renderSubcommandHelp,
      });
    };

    writeFixtureFile(
      distDir,
      "build-info.json",
      JSON.stringify({ version: "2026.7.2", commit: "a".repeat(40) }),
    );
    await writeMetadata();
    await writeMetadata();
    expect(renderCount).toBe(1);
    expect(commandRenderCount).toBe(4);
    expect(readFileSync(outputPath, "utf8")).toContain("OpenClaw 2026.7.2 (aaaaaaa)");

    writeFixtureFile(
      distDir,
      "build-info.json",
      JSON.stringify({ version: "2026.7.2", commit: "b".repeat(40) }),
    );
    await writeMetadata();
    expect(renderCount).toBe(2);
    expect(commandRenderCount).toBe(8);
    expect(readFileSync(outputPath, "utf8")).toContain("OpenClaw 2026.7.2 (bbbbbbb)");

    writeFixtureFile(
      distDir,
      "build-info.json",
      JSON.stringify({ version: "2026.7.3", commit: "b".repeat(40) }),
    );
    await writeMetadata();
    expect(renderCount).toBe(3);
    expect(commandRenderCount).toBe(12);
    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      subcommandHelpText: { models: string };
    };
    expect(written.subcommandHelpText.models).toContain("OpenClaw 2026.7.3 (bbbbbbb)");
  });
});
