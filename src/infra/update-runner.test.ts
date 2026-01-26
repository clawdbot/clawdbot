import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGatewayUpdate } from "./update-runner.js";

type CommandResult = { stdout?: string; stderr?: string; code?: number };

function createRunner(responses: Record<string, CommandResult>) {
  const calls: string[] = [];
  const runner = async (argv: string[]) => {
    const key = argv.join(" ");
    calls.push(key);
    const res = responses[key] ?? {};
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      code: res.code ?? 0,
    };
  };
  return { runner, calls };
}

describe("runGatewayUpdate", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-update-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("skips git update when worktree is dirty", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "clawdbot", version: "1.0.0" }),
      "utf-8",
    );
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: "main" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: " M README.md" },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dirty");
    expect(calls.some((call) => call.includes("rebase"))).toBe(false);
  });

  it("aborts rebase on failure", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "clawdbot", version: "1.0.0" }),
      "utf-8",
    );
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: "main" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: "upstream123" },
      [`git -C ${tempDir} rev-list --max-count=10 upstream123`]: { stdout: "upstream123\n" },
      [`git -C ${tempDir} rebase upstream123`]: { code: 1, stderr: "conflict" },
      [`git -C ${tempDir} rebase --abort`]: { stdout: "" },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("rebase-failed");
    expect(calls.some((call) => call.includes("rebase --abort"))).toBe(true);
  });

  it("uses stable tag when beta tag is older than release", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "clawdbot", version: "1.0.0", packageManager: "pnpm@8.0.0" }),
      "utf-8",
    );
    const stableTag = "v1.0.1-1";
    const betaTag = "v1.0.0-beta.2";
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} tag --list v* --sort=-v:refname`]: {
        stdout: `${stableTag}\n${betaTag}\n`,
      },
      [`git -C ${tempDir} checkout --detach ${stableTag}`]: { stdout: "" },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [`git -C ${tempDir} checkout -- dist/control-ui/`]: { stdout: "" },
      "pnpm clawdbot doctor --non-interactive": { stdout: "" },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
      channel: "beta",
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${stableTag}`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout --detach ${betaTag}`);
  });

  it("skips update when no git root", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "clawdbot", packageManager: "pnpm@8.0.0" }),
      "utf-8",
    );
    await fs.writeFile(path.join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { code: 1 },
      "npm root -g": { code: 1 },
      "pnpm root -g": { code: 1 },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not-git-install");
    expect(calls.some((call) => call.startsWith("pnpm add -g"))).toBe(false);
    expect(calls.some((call) => call.startsWith("npm i -g"))).toBe(false);
  });

  it("updates global npm installs when detected", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "clawdbot");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "clawdbot", version: "1.0.0" }),
      "utf-8",
    );

    const calls: string[] = [];
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      if (key === `git -C ${pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        return { stdout: nodeModules, stderr: "", code: 0 };
      }
      if (key === "npm i -g clawdbot@latest") {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "clawdbot", version: "2.0.0" }),
          "utf-8",
        );
        return { stdout: "ok", stderr: "", code: 0 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runGatewayUpdate({
      cwd: pkgRoot,
      runCommand: async (argv, _options) => runCommand(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.before?.version).toBe("1.0.0");
    expect(result.after?.version).toBe("2.0.0");
    expect(calls.some((call) => call === "npm i -g clawdbot@latest")).toBe(true);
  });

  it("updates global npm installs with tag override", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "clawdbot");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "clawdbot", version: "1.0.0" }),
      "utf-8",
    );

    const calls: string[] = [];
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      if (key === `git -C ${pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        return { stdout: nodeModules, stderr: "", code: 0 };
      }
      if (key === "npm i -g clawdbot@beta") {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "clawdbot", version: "2.0.0" }),
          "utf-8",
        );
        return { stdout: "ok", stderr: "", code: 0 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runGatewayUpdate({
      cwd: pkgRoot,
      runCommand: async (argv, _options) => runCommand(argv),
      timeoutMs: 5000,
      tag: "beta",
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.before?.version).toBe("1.0.0");
    expect(result.after?.version).toBe("2.0.0");
    expect(calls.some((call) => call === "npm i -g clawdbot@beta")).toBe(true);
  });

  it("updates global bun installs when detected", async () => {
    const oldBunInstall = process.env.BUN_INSTALL;
    const bunInstall = path.join(tempDir, "bun-install");
    process.env.BUN_INSTALL = bunInstall;

    try {
      const bunGlobalRoot = path.join(bunInstall, "install", "global", "node_modules");
      const pkgRoot = path.join(bunGlobalRoot, "clawdbot");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.writeFile(
        path.join(pkgRoot, "package.json"),
        JSON.stringify({ name: "clawdbot", version: "1.0.0" }),
        "utf-8",
      );

      const calls: string[] = [];
      const runCommand = async (argv: string[]) => {
        const key = argv.join(" ");
        calls.push(key);
        if (key === `git -C ${pkgRoot} rev-parse --show-toplevel`) {
          return { stdout: "", stderr: "not a git repository", code: 128 };
        }
        if (key === "npm root -g") {
          return { stdout: "", stderr: "", code: 1 };
        }
        if (key === "pnpm root -g") {
          return { stdout: "", stderr: "", code: 1 };
        }
        if (key === "bun add -g clawdbot@latest") {
          await fs.writeFile(
            path.join(pkgRoot, "package.json"),
            JSON.stringify({ name: "clawdbot", version: "2.0.0" }),
            "utf-8",
          );
          return { stdout: "ok", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      };

      const result = await runGatewayUpdate({
        cwd: pkgRoot,
        runCommand: async (argv, _options) => runCommand(argv),
        timeoutMs: 5000,
      });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("bun");
      expect(result.before?.version).toBe("1.0.0");
      expect(result.after?.version).toBe("2.0.0");
      expect(calls.some((call) => call === "bun add -g clawdbot@latest")).toBe(true);
    } finally {
      if (oldBunInstall === undefined) delete process.env.BUN_INSTALL;
      else process.env.BUN_INSTALL = oldBunInstall;
    }
  });

  it("rejects git roots that are not a clawdbot checkout", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    cwdSpy.mockRestore();

    expect(result.status).toBe("error");
    expect(result.reason).toBe("not-clawdbot-root");
    expect(calls.some((call) => call.includes("status --porcelain"))).toBe(false);
  });
});
