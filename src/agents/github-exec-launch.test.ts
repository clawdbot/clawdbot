import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { buildGitHubExecLaunchArgv } from "./github-exec-launch.js";
import { getShellConfig } from "./shell-utils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const powershell = process.platform === "win32" ? getShellConfig().shell : "pwsh";
const hasPowerShell =
  spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      SystemRoot: process.env.SystemRoot,
      POWERSHELL_TELEMETRY_OPTOUT: "1",
    },
  }).status === 0;

describe.skipIf(!hasPowerShell)("GitHub launch PowerShell boundary", () => {
  it.each(["available", "missing"] as const)(
    "keeps the PowerShell owner and binds a %s profile privately",
    async (credentialState) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "github-powershell-")),
      );
      roots.push(root);
      const profile = path.join(root, "profile 'with spaces'");
      await fs.mkdir(profile, { mode: 0o700 });
      if (credentialState === "available") {
        await fs.writeFile(
          path.join(profile, "hosts.yml"),
          "github.com:\n  oauth_token: synthetic-powershell-token\n",
          { mode: 0o600 },
        );
      }
      const target = path.join(root, "target 'with spaces'.cjs");
      await fs.writeFile(
        target,
        `
        process.stdout.write(JSON.stringify({
          cwd: process.cwd(), selected: process.env.GH_TOKEN === "synthetic-powershell-token",
          cleared: !process.env.GITHUB_TOKEN,
        }));
        process.exitCode = 7;
      `,
      );
      const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const command = `& ${[process.execPath, target].map(quotePowerShell).join(" ")}; exit $LASTEXITCODE`;
      const launchArgv = withMockedWindowsPlatform(() =>
        buildGitHubExecLaunchArgv(
          [powershell, "-NoProfile", "-NonInteractive", "-Command", command],
          profile,
        ),
      );
      expect(JSON.stringify(launchArgv)).not.toContain("synthetic-powershell-token");
      const child = spawn(launchArgv[0]!, launchArgv.slice(1), {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SystemRoot: process.env.SystemRoot,
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          POWERSHELL_TELEMETRY_OPTOUT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (credentialState === "available") {
        expect(code).toBe(7);
        expect(JSON.parse(stdout)).toEqual({ cwd: root, selected: true, cleared: true });
        expect(stderr).toBe("");
      } else {
        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("GitHub Identity credential is unavailable or insecure");
      }
      expect(launchArgv[0]).toBe(powershell);
      expect(`${stdout}${stderr}`).not.toContain("synthetic-powershell-token");
    },
  );
});

describe.skipIf(process.platform === "win32")("GitHub launch source runtimes", () => {
  for (const runtime of [process.execPath, "bun"]) {
    it.skipIf(runtime === "bun" && spawnSync("bun", ["--version"]).status !== 0)(
      `preserves exact argv, private output and lineage with ${path.basename(runtime)}`,
      async () => {
        const artifacts = path.join(process.cwd(), ".artifacts");
        await fs.mkdir(artifacts, { recursive: true });
        const root = await fs.realpath(await fs.mkdtemp(path.join(artifacts, "github-launch-")));
        roots.push(root);
        const commandCwd = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "github-command-cwd-")),
        );
        roots.push(commandCwd);
        const profile = path.join(root, "profile 'with spaces'");
        await fs.mkdir(profile, { mode: 0o700 });
        await fs.writeFile(
          path.join(profile, "hosts.yml"),
          "github.com:\n  oauth_token: synthetic-source-token\n",
          { mode: 0o600 },
        );
        const target = path.join(root, "target.cjs");
        await fs.writeFile(
          target,
          `
          const fs = require("node:fs");
          const lineage = fs.fstatSync(3);
          process.stdout.write(JSON.stringify({
            args: process.argv.slice(2), cwd: process.cwd(),
            selected: process.env.GH_TOKEN === "synthetic-source-token",
            cleared: process.env.GITHUB_TOKEN === "",
            lineage: lineage.isSocket() || lineage.isFIFO(),
          }));
        `,
        );
        const driver = path.join(root, "driver.mts");
        // Exercise the source route in each runtime; real exec tests cover prepared artifacts.
        const source = new URL("./github-exec-launch.ts", import.meta.url).href;
        await fs.writeFile(
          driver,
          `
          import { spawn } from "node:child_process";
          import { buildGitHubExecLaunchArgv } from ${JSON.stringify(source)};
          const argv = buildGitHubExecLaunchArgv([process.execPath, ...process.argv.slice(3)], process.argv[2]);
          const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit", 3] });
          child.on("error", () => { process.exitCode = 1; });
          child.on("close", (code) => { process.exitCode = code ?? 1; });
        `,
        );
        const args = ["a b", "'quoted'", "$HOME", "$(false)", "line\nbreak", "--literal"];
        const argv = [
          ...(runtime === "bun" ? [] : ["--import", createRequire(import.meta.url).resolve("tsx")]),
          driver,
          profile,
          target,
          ...args,
        ];
        const child = spawn(runtime, argv, {
          cwd: commandCwd,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            ZDOTDIR: root,
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
          },
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          expect(stderr).toBe("");
          expect(code).toBe(0);
          expect(JSON.parse(stdout)).toEqual({
            args,
            cwd: commandCwd,
            selected: true,
            cleared: true,
            lineage: true,
          });
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
      },
    );
  }
});
