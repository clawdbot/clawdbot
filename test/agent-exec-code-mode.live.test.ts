import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectRootPackageExcludedExtensionDirs } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import type { AgentExecEnvelope } from "../src/commands/agent-exec-result.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const describeLive = isLiveTestEnabled() && openAiApiKey.length > 0 ? describe : describe.skip;

describeLive("agent exec Code Mode with environment authentication", () => {
  it("starts without configuration and completes dependent filesystem calls", async () => {
    const root = tempDirs.make("openclaw-agent-exec-code-mode-live-");
    const home = path.join(root, "home");
    const stateDir = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const tmpDir = path.join(root, "tmp");
    await Promise.all([home, stateDir, workspace, tmpDir].map((dir) => fs.mkdir(dir)));
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const installedRoot = path.join(root, "node_modules", "openclaw");
    const sourceDist = path.join(repoRoot, "dist");
    const excludedPlugins = collectRootPackageExcludedExtensionDirs({ cwd: repoRoot });
    await fs.mkdir(installedRoot, { recursive: true });
    await fs.copyFile(
      path.join(repoRoot, "package.json"),
      path.join(installedRoot, "package.json"),
    );
    // A source checkout discovers external plugins beside dist. Copy the built
    // distribution with its package exclusions so discovery sees a clean install.
    await fs.cp(sourceDist, path.join(installedRoot, "dist"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (source) => {
        const [directory, pluginId] = path.relative(sourceDist, source).split(path.sep);
        return (
          directory !== "extensions" || pluginId === undefined || !excludedPlugins.has(pluginId)
        );
      },
    });
    await fs.symlink(
      await fs.realpath(path.join(repoRoot, "node_modules")),
      path.join(installedRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const input = `code-mode-${randomUUID()}\n`;
    await fs.writeFile(path.join(workspace, "input.txt"), input);

    // Exercise production discovery: no inherited test shortcuts, authored
    // config, installed harness, external CLI credentials, or runtime override.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmpDir,
      TMP: tmpDir,
      TEMP: tmpDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENAI_API_KEY: openAiApiKey,
    };
    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          path.join(installedRoot, "dist", "entry.js"),
          "agent",
          "exec",
          "Use Code Mode and the filesystem read and write tools to read input.txt, then write " +
            "output.txt containing exactly the input bytes followed by processed and a newline. " +
            "Do not use a shell command. Reply with exactly DONE after the write completes.",
          "--auth-env-only",
          "--model",
          "openai/gpt-5.6-sol",
          "--code-mode",
          "code",
          "--local-model-lean",
          "--thinking",
          "low",
          "--cwd",
          workspace,
          "--state-dir",
          stateDir,
          "--timeout",
          "180",
          "--json",
        ],
        {
          cwd: workspace,
          env,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
          timeout: 300_000,
        },
      ));
    } catch (error) {
      // Child-process failures retain stdout/stderr; never attach that raw
      // error as a cause because live credentials could appear in diagnostics.
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line preserve-caught-error -- The raw cause can expose live credentials.
      throw new Error(message.replaceAll(openAiApiKey, "[REDACTED]"));
    }

    expect(stdout.includes(openAiApiKey) || stderr.includes(openAiApiKey)).toBe(false);
    const result = JSON.parse(stdout) as AgentExecEnvelope;
    expect(result).toMatchObject({
      ok: true,
      status: "ok",
      provider: "openai",
      model: "gpt-5.6-sol",
      codeModeEngaged: true,
      final: "DONE",
    });
    expect(result.toolSummary?.tools).toContain("exec");
    expect(result.bridgeCalls?.call).toBeGreaterThanOrEqual(2);
    await expect(fs.readFile(path.join(workspace, "output.txt"), "utf8")).resolves.toBe(
      `${input}processed\n`,
    );
  }, 330_000);
});
