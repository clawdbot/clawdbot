// iMessage plugin module implements imsg CLI install behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveBrewExecutable } from "openclaw/plugin-sdk/setup-tools";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { IMESSAGE_INSTALL_COMMAND } from "./setup-core.js";

type IMessageInstallResult = {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
};

async function resolveBrewIMessageCliPath(brewExe: string): Promise<string | null> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: [brewExe, "--prefix", "imsg"],
      timeoutMs: 10_000,
    });
    if (result.code !== 0 || !result.stdout.trim()) {
      return null;
    }
    const candidate = path.join(result.stdout.trim(), "bin", "imsg");
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export async function installIMessageCli(
  runtime: RuntimeEnv,
  opts?: { upgrade?: boolean },
): Promise<IMessageInstallResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      error: "imsg auto-install is supported only on macOS.",
    };
  }

  const brewExe = resolveBrewExecutable();
  if (!brewExe) {
    return {
      ok: false,
      error: `Homebrew is required for imsg setup. Install Homebrew (https://brew.sh), then run: ${IMESSAGE_INSTALL_COMMAND}`,
    };
  }

  runtime.log(`${opts?.upgrade ? "Updating" : "Installing"} imsg via Homebrew (${brewExe})...`);
  if (opts?.upgrade) {
    const update = await runPluginCommandWithTimeout({
      argv: [brewExe, "update"],
      timeoutMs: 5 * 60_000,
    });
    if (update.code !== 0) {
      return {
        ok: false,
        error: `brew update failed (exit ${update.code}): ${truncateUtf16Safe(update.stderr.trim(), 200)}`,
      };
    }
  }
  const command = opts?.upgrade ? ["upgrade", "imsg"] : ["install", "steipete/tap/imsg"];
  const result = await runPluginCommandWithTimeout({
    argv: [brewExe, ...command],
    timeoutMs: 15 * 60_000,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      error: `brew ${command.join(" ")} failed (exit ${result.code}): ${truncateUtf16Safe(result.stderr.trim(), 200)}`,
    };
  }

  const cliPath = await resolveBrewIMessageCliPath(brewExe);
  if (!cliPath) {
    return {
      ok: false,
      error: "brew install succeeded but imsg binary was not found.",
    };
  }

  let version: string | undefined;
  try {
    const versionResult = await runPluginCommandWithTimeout({
      argv: [cliPath, "--version"],
      timeoutMs: 10_000,
    });
    version = versionResult.stdout.trim() || undefined;
  } catch {
    // Version output is helpful but not required for setup.
  }

  return { ok: true, cliPath, version };
}
