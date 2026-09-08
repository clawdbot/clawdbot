import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { resolveExecutableFromUserShellPath as resolveExecutableFromUserShellPathInternal } from "../infra/shell-env.js";

export {
  decodeNodePtyResumeParams,
  decodeNodePtyStartParams,
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
  const resolve = (includeExtensionless: boolean) => {
    if (options.strategy === "direct") {
      const resolved = resolveExecutableFromPathEnv(
        executable,
        options.pathEnv ?? env.PATH ?? env.Path ?? "",
        env,
        { includeExtensionless },
      );
      return resolved ? { executable: resolved } : undefined;
    }
    return resolveExecutableFromUserShellPathInternal(executable, {
      env,
      pathEnv: options.pathEnv,
      includeExtensionless,
      strategy: options.strategy,
    });
  };
  if (options.includeExtensionless !== undefined || process.platform !== "win32") {
    return resolve(options.includeExtensionless ?? true);
  }
  // npm installs a non-runnable bare shim beside its .cmd launcher. Search every
  // PATH source for PATHEXT launchers before retaining bare-only native hosts.
  return resolve(false) ?? resolve(true);
}
