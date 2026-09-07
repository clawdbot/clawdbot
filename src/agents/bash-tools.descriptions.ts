/** Builds the model-facing exec tool description for the current platform and capabilities. */
export function describeExecTool(params?: {
  hasCronTool?: boolean;
  hasProcessTool?: boolean;
}): string {
  const continuation =
    params?.hasProcessTool === false
      ? ["Run shell and wait for completion."]
      : [
          "Run shell now; background continuation supported.",
          "Use yieldMs/background, then process for logs/status/input/intervention.",
          "Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion.",
        ];
  const base = [
    ...continuation,
    params?.hasCronTool ? "No sleep loops for reminders/follow-ups; use automations." : undefined,
    "TTY CLI/UI/coding agent: pty=true.",
  ]
    .filter(Boolean)
    .join(" ");
  if (process.platform !== "win32") {
    return `${base} Quote arguments containing shell metacharacters, including URL query strings with \`?\` or \`&\`.`;
  }
  const lines: string[] = [base];
  lines.push(
    "IMPORTANT (Windows): Run executables directly; do NOT wrap commands in `cmd /c`, `powershell -Command`, `& ` prefix, or WSL. Use backslash paths (C:\\path), not forward slashes. Use short executable names (e.g. `node`, `python3`) instead of full paths.",
  );
  return lines.join("\n");
}

/** Builds the model-facing process-control tool description. */
export function describeProcessTool(params?: { hasCronTool?: boolean }): string {
  return [
    "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill.",
    "poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention.",
    params?.hasCronTool
      ? "No polling as timer/reminder; scheduled follow-up uses automations."
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}
