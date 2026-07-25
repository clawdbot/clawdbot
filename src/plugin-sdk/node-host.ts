import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { resolveExecutableFromUserShellPath as resolveExecutableFromUserShellPathInternal } from "../infra/shell-env.js";

export {
  decodeNodePtyResumeParams,
  runNodePtyCommand,
  type NodePtyCommandResult,
  type NodePtyResumeParams,
} from "../node-host/pty-command.js";
export { validateClaudeSessionId } from "../node-host/invoke-agent-cli-claude-params.js";
export type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";

/** Resolve a node-host executable using the selected PATH source policy. */
export function resolveNodeHostExecutable(
  executable: string,
  options: {
    env?: NodeJS.ProcessEnv;
    pathEnv?: string;
    includeExtensionless?: boolean;
    strategy: "direct" | "fallback" | "prefer";
  },
): { executable: string; pathEnv?: string } | undefined {
  const env = options.env ?? process.env;
  if (options.strategy === "direct") {
    const resolved = resolveExecutableFromPathEnv(
      executable,
      options.pathEnv ?? env.PATH ?? env.Path ?? "",
      env,
      { includeExtensionless: options.includeExtensionless },
    );
    return resolved ? { executable: resolved } : undefined;
  }
  return resolveExecutableFromUserShellPathInternal(executable, {
    env,
    pathEnv: options.pathEnv,
    includeExtensionless: options.includeExtensionless,
    strategy: options.strategy,
  });
}
