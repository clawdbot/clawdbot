import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedMemoryWikiConfig } from "./config.js";

const execFileAsync = promisify(execFile);

type ObsidianCliProbe = {
  available: boolean;
  command: string | null;
};

type ObsidianCliResult = {
  command: string;
  argv: string[];
  stdout: string;
  stderr: string;
};

type ObsidianCliDeps = {
  exec?: typeof execFileAsync;
  resolveCommand?: (command: string) => Promise<string | null>;
};

async function isExecutableFile(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandOnPath(command: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const windowsExts =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"])
      : [""];

  if (command.includes(path.sep)) {
    return (await isExecutableFile(command)) ? command : null;
  }

  for (const dir of pathEntries) {
    for (const extension of windowsExts) {
      const candidate = path.join(dir, extension ? `${command}${extension}` : command);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function buildVaultPrefix(config: ResolvedMemoryWikiConfig): string[] {
  return config.obsidian.vaultName ? [`vault=${config.obsidian.vaultName}`] : [];
}

export async function probeObsidianCli(
  deps?: Pick<ObsidianCliDeps, "resolveCommand">,
): Promise<ObsidianCliProbe> {
  const resolveCommand = deps?.resolveCommand ?? resolveCommandOnPath;
  const command = await resolveCommand("obsidian");
  return {
    available: command !== null,
    command,
  };
}

async function runObsidianCli(params: {
  config: ResolvedMemoryWikiConfig;
  subcommand: string;
  args?: string[];
  deps?: ObsidianCliDeps;
}): Promise<ObsidianCliResult> {
  const resolveCommand = params.deps?.resolveCommand ?? resolveCommandOnPath;
  const exec = params.deps?.exec ?? execFileAsync;
  const probe = await probeObsidianCli({ resolveCommand });
  if (!probe.command) {
    throw new Error("Obsidian CLI is not available on PATH.");
  }
  const argv = [...buildVaultPrefix(params.config), params.subcommand, ...(params.args ?? [])];
  const { stdout, stderr } = await exec(probe.command, argv, { encoding: "utf8" });
  return {
    command: probe.command,
    argv,
    stdout,
    stderr,
  };
}

export async function runObsidianSearch(params: {
  config: ResolvedMemoryWikiConfig;
  query: string;
  deps?: ObsidianCliDeps;
}) {
  return await runObsidianCli({
    config: params.config,
    subcommand: "search",
    args: [`query=${params.query}`],
    deps: params.deps,
  });
}

export async function runObsidianOpen(params: {
  config: ResolvedMemoryWikiConfig;
  vaultPath: string;
  deps?: ObsidianCliDeps;
}) {
  return await runObsidianCli({
    config: params.config,
    subcommand: "open",
    args: [`path=${params.vaultPath}`],
    deps: params.deps,
  });
}

export async function runObsidianCommand(params: {
  config: ResolvedMemoryWikiConfig;
  id: string;
  deps?: ObsidianCliDeps;
}) {
  return await runObsidianCli({
    config: params.config,
    subcommand: "command",
    args: [`id=${params.id}`],
    deps: params.deps,
  });
}

export async function runObsidianDaily(params: {
  config: ResolvedMemoryWikiConfig;
  deps?: ObsidianCliDeps;
}) {
  return await runObsidianCli({
    config: params.config,
    subcommand: "daily",
    deps: params.deps,
  });
}
