// Resolves Windows system binaries without trusting PATH.
import {
  resolveWindowsPowerShellPath,
  resolveWindowsSystem32Path,
} from "../windows-cmd-helpers.mjs";

export { resolveWindowsPowerShellPath, resolveWindowsSystem32Path };

export function resolveWindowsTaskkillPath(env = process.env) {
  return resolveWindowsSystem32Path("taskkill.exe", env);
}
