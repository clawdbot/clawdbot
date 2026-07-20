const DEFAULT_PTY_TERMINAL_NAME = "xterm-256color";

export function readPtyTerminalName(
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!env || platform !== "win32" || env.TERM !== undefined) {
    return env?.TERM;
  }
  const termEntry = Object.entries(env).find(([key]) => key.toLowerCase() === "term");
  return termEntry?.[1];
}

export function resolvePtyTerminalName(value: string | undefined): string {
  const normalized = value?.trim();
  return !normalized || normalized.toLowerCase() === "dumb"
    ? DEFAULT_PTY_TERMINAL_NAME
    : normalized;
}

export function setPtyTerminalName(params: {
  env: NodeJS.ProcessEnv;
  name: string;
  platform: NodeJS.Platform;
}): void {
  if (params.platform === "win32") {
    for (const key of Object.keys(params.env)) {
      if (key !== "TERM" && key.toLowerCase() === "term") {
        delete params.env[key];
      }
    }
  }
  params.env.TERM = params.name;
}
