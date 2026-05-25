import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePnpmRunner } from "../pnpm-runner.mjs";

export function resolveGeneratedModuleFormatter(params) {
  const platform = params.platform ?? process.platform;
  const existsSync = params.existsSync ?? fs.existsSync;
  const directFormatterPath = path.join(params.repoRoot, "node_modules", ".bin", "oxfmt");
  const useDirectFormatter = platform !== "win32" && existsSync(directFormatterPath);
  if (useDirectFormatter) {
    return {
      command: directFormatterPath,
      args: ["--write", params.outputPath],
      shell: false,
    };
  }

  return resolvePnpmRunner({
    comSpec: params.comSpec,
    npmExecPath: params.npmExecPath,
    nodeExecPath: params.nodeExecPath,
    platform,
    pnpmArgs: ["exec", "oxfmt", "--write", params.outputPath],
  });
}

export function formatGeneratedModule(source, { repoRoot, outputPath, errorLabel }) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedOutputPath = path.resolve(
    resolvedRepoRoot,
    path.isAbsolute(outputPath) ? path.relative(resolvedRepoRoot, outputPath) : outputPath,
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-generated-format-"));
  const tempOutputPath = path.join(tempDir, path.basename(resolvedOutputPath));

  try {
    fs.writeFileSync(tempOutputPath, source, "utf8");
    const command = resolveGeneratedModuleFormatter({
      existsSync: fs.existsSync,
      outputPath: tempOutputPath,
      repoRoot: resolvedRepoRoot,
    });
    const formatter = spawnSync(command.command, command.args, {
      cwd: resolvedRepoRoot,
      encoding: "utf8",
      env: command.env ?? process.env,
      shell: command.shell,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    if (formatter.status !== 0) {
      const details =
        formatter.stderr?.trim() ||
        formatter.stdout?.trim() ||
        formatter.error?.message ||
        "unknown formatter failure";
      throw new Error(`failed to format generated ${errorLabel}: ${details}`);
    }
    return fs.readFileSync(tempOutputPath, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
