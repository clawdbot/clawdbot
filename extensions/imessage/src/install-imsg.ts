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

const IMESSAGE_BREW_FORMULA = "steipete/tap/imsg";

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveBrewManagedIMessageCliPath(
  brewExe: string,
  cliPath: string,
): Promise<string | null> {
  try {
    const formulae = await runPluginCommandWithTimeout({
      argv: [brewExe, "list", "--formula", "--full-name"],
      timeoutMs: 10_000,
    });
    const installed = formulae.stdout
      .split(/\r?\n/u)
      .some((formula) => formula.trim() === IMESSAGE_BREW_FORMULA);
    if (formulae.code !== 0 || !installed) {
      return null;
    }

    let resolvedCliPath = cliPath;
    if (!path.isAbsolute(resolvedCliPath)) {
      const resolved = await runPluginCommandWithTimeout({
        argv: ["/usr/bin/env", "which", resolvedCliPath],
        timeoutMs: 10_000,
      });
      resolvedCliPath =
        resolved.code === 0 ? (resolved.stdout.split(/\r?\n/u)[0]?.trim() ?? "") : "";
    }
    if (!resolvedCliPath) {
      return null;
    }

    const cellar = await runPluginCommandWithTimeout({
      argv: [brewExe, "--cellar"],
      timeoutMs: 10_000,
    });
    if (cellar.code !== 0 || !cellar.stdout.trim()) {
      return null;
    }
    const [realCliPath, realFormulaPath] = await Promise.all([
      fs.realpath(resolvedCliPath),
      fs.realpath(path.join(cellar.stdout.trim(), "imsg")),
    ]);
    // An installed receipt alone does not own a shadowing PATH wrapper. Only
    // upgrade when the executable itself resolves into this formula's Cellar rack.
    return isPathInside(realFormulaPath, realCliPath) ? resolvedCliPath : null;
  } catch {
    return null;
  }
}

async function resolveBrewIMessageCliPath(brewExe: string): Promise<string | null> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: [brewExe, "--prefix"],
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
  opts?: { upgrade?: boolean; cliPath?: string },
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
    const managedCliPath = await resolveBrewManagedIMessageCliPath(brewExe, opts.cliPath ?? "imsg");
    if (!managedCliPath) {
      runtime.log("Keeping the detected imsg binary because Homebrew does not manage it.");
      return { ok: true };
    }
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
