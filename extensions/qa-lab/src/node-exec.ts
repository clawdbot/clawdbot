// Qa Lab plugin module implements node exec behavior.
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = async (file, args, options) =>
  await runExec(file, [...args], { baseEnv: options.env, logOutput: false });

function isNodeExecPath(execPath: string, platform: NodeJS.Platform): boolean {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const basename = pathModule.basename(execPath).toLowerCase();
  return (
    basename === "node" ||
    basename === "node.exe" ||
    basename === "nodejs" ||
    basename === "nodejs.exe"
  );
}

export async function resolveQaNodeExecPath(params?: {
  execPath?: string;
  platform?: NodeJS.Platform;
  versions?: NodeJS.ProcessVersions;
  env?: NodeJS.ProcessEnv;
  execFileImpl?: ExecFileAsync;
}): Promise<string> {
  const execPath = params?.execPath ?? process.execPath;
  const platform = params?.platform ?? process.platform;
  const versions = params?.versions ?? process.versions;
  if (typeof versions.bun !== "string" && isNodeExecPath(execPath, platform)) {
    return execPath;
  }

  const locator =
    platform === "win32" ? resolveQaWindowsSystem32ExePath("where.exe", params?.env) : "which";
  const execFileImpl = params?.execFileImpl ?? execFileAsync;
  let stdout;
  try {
    ({ stdout } = await execFileImpl(locator, ["node"], {
      encoding: "utf8",
      env: params?.env,
    }));
  } catch {
    throw new Error(
      "Node not found in PATH. QA live lanes require Node for child gateway and CLI processes.",
    );
  }

  const resolved = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!resolved) {
    throw new Error(
      "Node not found in PATH. QA live lanes require Node for child gateway and CLI processes.",
    );
  }
  return resolved;
}
