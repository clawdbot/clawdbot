import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveLaunchAgentPlistPathForLabel } from "../../daemon/launchd-service-files.js";

function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function renderLaunchdPlistSelection(
  env: NodeJS.ProcessEnv,
  label: string,
  launchAgentPlistSourcePath?: string,
): string {
  const home = normalizeOptionalString(env.HOME) || process.env.HOME || os.homedir();
  const plistPath = resolveLaunchAgentPlistPathForLabel({ ...env, HOME: home }, label);
  const sourcePlistPath = normalizeOptionalString(launchAgentPlistSourcePath);
  const fallbackPlistPath =
    sourcePlistPath && path.isAbsolute(sourcePlistPath) && sourcePlistPath !== plistPath
      ? sourcePlistPath
      : undefined;
  const canonicalSelection = `openclaw_launch_agent_plist='${shellEscape(plistPath)}'`;
  if (!fallbackPlistPath) {
    return canonicalSelection;
  }
  // A canonical directory entry wins even when its symlink target is temporarily missing.
  // Fall back only when rollback left no canonical entry at all.
  return `${canonicalSelection}
if [ ! -e "$openclaw_launch_agent_plist" ] && [ ! -L "$openclaw_launch_agent_plist" ]; then
  openclaw_launch_agent_plist='${shellEscape(fallbackPlistPath)}'
fi`;
}
