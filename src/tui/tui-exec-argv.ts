export function filterTuiExecArgv(execArgv: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index] ?? "";
    // Strip inspector flags so TUI-owned children cannot contend with or pause beneath
    // the parent debugger.
    if (
      arg === "--inspect" ||
      arg.startsWith("--inspect=") ||
      arg === "--inspect-brk" ||
      arg.startsWith("--inspect-brk=") ||
      arg === "--inspect-wait" ||
      arg.startsWith("--inspect-wait=")
    ) {
      const next = execArgv[index + 1];
      if (!arg.includes("=") && typeof next === "string" && !next.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg === "--inspect-port") {
      const next = execArgv[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--inspect-port=")) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}
