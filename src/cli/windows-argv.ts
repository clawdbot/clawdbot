// Windows launcher normalization for npm/bun wrappers that duplicate node.exe in argv.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Remove duplicated Windows node launcher argv entries while preserving normal POSIX argv. */
export function normalizeWindowsArgv(
  argv: string[],
  options: {
    platform?: NodeJS.Platform;
    execPath?: string;
  } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return argv;
  }
  if (argv.length < 2) {
    return argv;
  }

  const stripControlChars = (value: string): string => {
    let out = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 32 && code !== 127) {
        out += value[i];
      }
    }
    return out;
  };

  const normalizeArg = (value: string): string =>
    stripControlChars(value)
      .replace(/^['"]+|['"]+$/g, "")
      .trim();
  const normalizeCandidate = (value: string): string =>
    normalizeArg(value).replace(/^\\\\\\?\\/, "");
  const basename = (value: string): string => value.split(/[\\/]/).pop() ?? value;

  const execPath = normalizeCandidate(options.execPath ?? process.execPath);
  const execPathLower = normalizeLowercaseStringOrEmpty(execPath);
  const execBase = normalizeLowercaseStringOrEmpty(basename(execPath));
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) {
      return false;
    }
    const normalized = normalizeCandidate(value);
    if (!normalized) {
      return false;
    }
    const lower = normalizeLowercaseStringOrEmpty(normalized);
    const base = basename(lower);
    return (
      lower === execPathLower ||
      base === execBase ||
      lower.endsWith("\\node.exe") ||
      lower.endsWith("/node.exe") ||
      base === "node.exe"
    );
  };

  const argv0IsExecPath = isExecPath(argv[0]);
  const next = [...argv];
  let removedLauncherPrefix = false;
  for (const i = 1; i < next.length;) {
    if (isExecPath(next[i])) {
      next.splice(i, 1);
      removedLauncherPrefix = true;
      continue;
    }
    break;
  }
  if (next.length < 3 || (!argv0IsExecPath && !removedLauncherPrefix)) {
    return next;
  }
  const cleaned = [...next];
  for (const i = 2; i < cleaned.length;) {
    const arg = cleaned[i];
    if (!arg || arg.startsWith("-")) {
      break;
    }
    if (isExecPath(arg)) {
      cleaned.splice(i, 1);
      continue;
    }
    break;
  }
  return cleaned;
}
