import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing, writeCliStartupMetadata } from "../../scripts/write-cli-startup-metadata.ts";
import { createScriptTestHarness } from "./test-helpers.js";

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

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
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

describe("write-cli-startup-metadata", () => {
  const { createTempDir } = createScriptTestHarness();

  it("caps concurrent metadata render workers while preserving result order", async () => {
    let active = 0;
    let peakActive = 0;

    const result = await __testing.mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      active -= 1;
      return `rendered-${value}`;
    });

    expect(result).toEqual(["rendered-1", "rendered-2", "rendered-3", "rendered-4", "rendered-5"]);
    expect(peakActive).toBe(2);
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
});
