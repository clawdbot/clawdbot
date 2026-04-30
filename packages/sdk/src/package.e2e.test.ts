import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type CommandResult = {
  stdout: string;
  stderr: string;
};

const COMMAND_TIMEOUT_MS = 120_000;
const tempDirs: string[] = [];

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `command timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms: ${[
            command,
            ...args,
          ].join(" ")}`,
        ),
      );
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `command failed (${String(code ?? signal)}): ${[command, ...args].join(" ")}\n` +
            `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        ),
      );
    });
  });
}

describe("OpenClaw SDK package e2e", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("packs and imports from an external temp consumer", async () => {
    const repoRoot = process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "sdk");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-consumer-"));
    tempDirs.push(tempDir);

    await runCommand("pnpm", ["--filter", "@openclaw/sdk", "build"], {
      cwd: repoRoot,
      timeoutMs: 180_000,
    });
    await runCommand("pnpm", ["pack", "--pack-destination", tempDir], {
      cwd: packageRoot,
    });

    const packedFiles = (await fs.readdir(tempDir)).filter((file) => file.endsWith(".tgz"));
    expect(packedFiles).toHaveLength(1);
    const tarball = path.join(tempDir, packedFiles[0] ?? "");

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: tempDir,
    });

    const importScript = `
      import { GatewayClientTransport, OpenClaw, normalizeGatewayEvent } from "@openclaw/sdk";
      if (typeof GatewayClientTransport !== "function") throw new Error("missing transport export");
      if (typeof OpenClaw !== "function") throw new Error("missing client export");
      const event = normalizeGatewayEvent({
        event: "agent",
        payload: { runId: "pack-smoke", stream: "lifecycle", data: { phase: "start" } }
      });
      if (event.type !== "run.started") throw new Error("unexpected event normalization");
    `;
    await runCommand(process.execPath, ["--input-type=module", "-e", importScript], {
      cwd: tempDir,
    });
  });
});
