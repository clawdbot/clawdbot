import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPnpmRunnerSpawnSpec } from "../../scripts/pnpm-runner.mts";
import { mergeProcessEnv } from "../../src/infra/process-env.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const toolEntries: Record<string, string> = {
  vite: "bin/vite.js",
  vitest: "vitest.mjs",
  playwright: "cli.js",
};
const commands = [
  { directory: "packages/mermaid-renderer", script: "build", tool: "vite", args: ["build"] },
  { directory: "ui", script: "build", tool: "vite", args: ["build"] },
  { directory: "ui", script: "dev", tool: "vite", args: [] },
  { directory: "ui", script: "preview", tool: "vite", args: ["preview"] },
  {
    directory: "ui",
    script: "test",
    tool: "vitest",
    args: ["run", "--config", "vitest.config.ts"],
  },
  {
    directory: ".",
    script: "qa:lab:build",
    tool: "vite",
    args: ["build", "--config", "extensions/qa-lab/web/vite.config.ts"],
  },
  {
    directory: ".",
    script: "qa:lab:watch",
    tool: "vite",
    args: ["build", "--watch", "--config", "extensions/qa-lab/web/vite.config.ts"],
  },
];

function writeTool(modules: string, tool: string, scope: string, exitCode: number): string {
  const directory = path.join(modules, tool);
  const entry = toolEntries[tool]!;
  const executable = path.join(directory, entry);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: tool,
      type: "module",
      exports: { ".": "./index.mjs", "./package.json": "./package.json" },
      bin: { [tool]: entry },
    }),
  );
  fs.writeFileSync(path.join(directory, "index.mjs"), "export const chromium = {};\n");
  fs.writeFileSync(
    executable,
    `import fs from "node:fs";
fs.writeFileSync(process.env.PACKAGE_BIN_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd(),
  scope: ${JSON.stringify(scope)}, marker: process.env.PACKAGE_BIN_MARKER
}));
process.exitCode = ${exitCode};
`,
  );
  return executable;
}

function writeShim(modules: string, tool: string): void {
  const directory = path.join(modules, ".bin");
  const entry = toolEntries[tool]!;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, tool),
    `#!/bin/sh\nexec node "$(dirname "$0")/../${tool}/${entry}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(directory, `${tool}.cmd`),
    `@echo off\r\nnode "%~dp0..\\${tool}\\${entry.replaceAll("/", "\\")}" %*\r\n`,
  );
}

describe("Node package tool commands", () => {
  it.each(
    commands.flatMap(({ directory, script, tool, args }) =>
      (directory === "." ? ["hoisted"] : ["hoisted", "isolated"]).map((layout) => ({
        directory,
        script,
        tool,
        args,
        layout,
      })),
    ),
  )(
    "runs $directory $script with $layout dependencies and package-local shims",
    ({ directory, script, tool, args, layout }) => {
      const root = fs.realpathSync(createTempDir("openclaw-package-bin-"));
      const cwd = path.resolve(root, directory);
      const capture = path.join(root, "capture.json");
      const expectedExit = tool === "vitest" ? 17 : 0;
      const forwarded = ["--help", "--mode", "fixture with spaces"];
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}\n');
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          scripts: { [script]: manifest.scripts[script] },
        }),
      );
      const launcher = "scripts/run-node-package-bin.mts";
      if (fs.existsSync(launcher)) {
        fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
        fs.copyFileSync(launcher, path.join(root, launcher));
      }
      const rootModules = path.join(root, "node_modules");
      let entry = writeTool(rootModules, tool, "root", expectedExit);
      writeShim(rootModules, tool);
      if (directory !== ".") {
        const localModules = path.join(cwd, "node_modules");
        if (layout === "isolated") {
          entry = writeTool(localModules, tool, "local", expectedExit);
        }
        // The hoisted layout retains this executable shim after its target moves
        // to the root; pnpm still puts it ahead of the healthy ancestor shim.
        writeShim(localModules, tool);
      }
      const env = mergeProcessEnv([
        process.env,
        {
          PATH: [path.dirname(process.execPath), process.env.PATH]
            .filter(Boolean)
            .join(path.delimiter),
          PACKAGE_BIN_CAPTURE: capture,
          PACKAGE_BIN_MARKER: "forwarded",
        },
      ]);
      const spec = createPnpmRunnerSpawnSpec({
        cwd: root,
        env,
        pnpmArgs: ["--dir", cwd, "run", script, ...forwarded],
      });
      const result = spawnSync(spec.command, spec.args, {
        ...spec.options,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(expectedExit);
      expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
        args: [...args, ...forwarded],
        entry,
        cwd,
        scope: layout === "isolated" ? "local" : "root",
        marker: "forwarded",
      });
    },
  );

  it.each(["hoisted", "isolated"])(
    "installs browser dependencies from %s packages without following stale UI shims",
    (layout) => {
      const root = fs.realpathSync(createTempDir("openclaw-playwright-bin-"));
      const ui = path.join(root, "ui");
      const capture = path.join(root, "capture.json");
      fs.mkdirSync(path.join(root, ".git"));
      fs.mkdirSync(ui);
      for (const directory of [root, ui]) {
        fs.writeFileSync(
          path.join(directory, "package.json"),
          '{"private":true,"type":"module"}\n',
        );
      }
      for (const file of [
        "scripts/ensure-playwright-chromium.mts",
        "scripts/run-node-package-bin.mts",
        "scripts/pnpm-runner.mts",
        "scripts/windows-cmd-helpers.mjs",
        "scripts/lib/arg-utils.mts",
        "scripts/lib/arg-utils.runtime.mjs",
        "scripts/lib/record-shared.mjs",
        "scripts/lib/repo-root.mjs",
        "scripts/lib/windows-cmd-helpers-runtime.mts",
        "packages/normalization-core/src/record-coerce.ts",
        "packages/normalization-core/src/string-coerce.ts",
        "packages/normalization-core/src/utf16-slice.ts",
      ]) {
        if (fs.existsSync(file)) {
          const destination = path.join(root, file);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(file, destination);
        }
      }
      const rootModules = path.join(root, "node_modules");
      const localModules = path.join(ui, "node_modules");
      let entry = writeTool(rootModules, "playwright", "root", 0);
      writeShim(rootModules, "playwright");
      if (layout === "isolated") {
        entry = writeTool(localModules, "playwright", "local", 0);
      }
      writeShim(localModules, "playwright");
      fs.writeFileSync(
        path.join(root, "probe.mjs"),
        `import { spawnSync } from "node:child_process";
import { ensurePlaywrightChromium } from "./scripts/ensure-playwright-chromium.mts";
process.exitCode = ensurePlaywrightChromium({
  executablePath: "fixture-browser", existsSync: () => true, ensureFfmpeg: true,
  spawnSync(command, args, options) {
    return command === "fixture-browser" ? { status: 0 } : spawnSync(command, args, options);
  }
});\n`,
      );
      const result = spawnSync(process.execPath, [path.join(root, "probe.mjs")], {
        cwd: root,
        env: mergeProcessEnv([
          process.env,
          {
            PATH: [path.dirname(process.execPath), process.env.PATH]
              .filter(Boolean)
              .join(path.delimiter),
            PACKAGE_BIN_CAPTURE: capture,
            PACKAGE_BIN_MARKER: "forwarded",
            PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: undefined,
          },
        ]),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
        args: ["install", "ffmpeg"],
        entry,
        cwd: ui,
        scope: layout === "isolated" ? "local" : "root",
        marker: "forwarded",
      });
    },
  );
});
