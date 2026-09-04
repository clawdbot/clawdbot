import { statSync } from "node:fs";
import path from "node:path";
import { resolveWindowsSpawnProgram } from "openclaw/plugin-sdk/windows-spawn";

const CLAUDE_CODE_PACKAGE_NAME = "@anthropic-ai/claude-code";
const DEFAULT_WINDOWS_PATH_EXT = [".exe", ".cmd", ".bat", ".com"];
/**
 * Script extensions the Agent SDK runs through its own Node executable: it
 * prepends `node` to `pathToClaudeCodeExecutable` only for these extensions
 * and spawns anything else directly. Keep in sync with the SDK's launcher.
 */
const AGENT_SDK_NODE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx", ".jsx"];

function isExistingFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function readWindowsPathExt(env: Record<string, string>): string[] {
  let raw: string | undefined;
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === "PATHEXT") {
      raw = value;
      break;
    }
  }
  raw ??= process.env.PATHEXT;
  const extensions = (raw ?? DEFAULT_WINDOWS_PATH_EXT.join(";"))
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
  return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATH_EXT;
}

/**
 * The host may pre-resolve a bare backend command to npm's extensionless POSIX
 * shim, which PATHEXT-unaware callers cannot spawn. Probe PATHEXT siblings in
 * the same directory so wrapper resolution sees the real Windows file.
 */
function probeWindowsPathExtSibling(
  command: string,
  env: Record<string, string>,
): string | undefined {
  if (path.extname(command)) {
    return undefined;
  }
  const rooted = command.includes("/") || command.includes("\\") || path.isAbsolute(command);
  if (!rooted || !isExistingFile(command)) {
    return undefined;
  }
  for (const extension of readWindowsPathExt(env)) {
    const candidate = `${command}${extension}`;
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the spawnable Claude Code executable for the Agent SDK.
 *
 * On Windows the SDK spawns `pathToClaudeCodeExecutable` directly, so a bare
 * command or an extensionless npm shim fails to launch. Reuse the same
 * PATH/PATHEXT and wrapper resolution the CLI identity layer applies, yielding
 * the package's native entrypoint. Other platforms keep the host-provided
 * command unchanged.
 */
export function resolveClaudeAgentSdkExecutable(params: {
  command: string;
  env: Record<string, string>;
  platform?: NodeJS.Platform;
}): string {
  const platform = params.platform ?? process.platform;
  const command = params.command.trim();
  if (platform !== "win32" || !command) {
    return params.command;
  }
  try {
    const program = resolveWindowsSpawnProgram({
      command: probeWindowsPathExtSibling(command, params.env) ?? command,
      platform,
      env: params.env,
      packageName: CLAUDE_CODE_PACKAGE_NAME,
    });
    if (program.resolution === "node-entrypoint") {
      // The SDK represents a Node-script launcher as its own Node executable
      // plus the script argument, but pathToClaudeCodeExecutable is a single
      // path. Hand the SDK only scripts it knows how to run via Node; any
      // other entrypoint shape falls back to the host-provided command.
      const script = program.leadingArgv[0];
      if (
        script &&
        AGENT_SDK_NODE_SCRIPT_EXTENSIONS.some((extension) =>
          script.toLowerCase().endsWith(extension),
        )
      ) {
        return script;
      }
      return params.command;
    }
    return program.command;
  } catch {
    return params.command;
  }
}
