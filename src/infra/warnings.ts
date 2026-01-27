const warningFilterKey = Symbol.for("moltbot.warning-filter");

type Warning = Error & {
  code?: string;
  name?: string;
  message?: string;
};

function shouldIgnoreWarning(warning: Warning): boolean {
  if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
    return true;
  }
  if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) {
    return true;
  }
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message?.includes("SQLite is an experimental feature")
  ) {
    return true;
  }
  return false;
}

export function installProcessWarningFilter(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: { installed: boolean };
  };
  if (globalState[warningFilterKey]?.installed) return;
  globalState[warningFilterKey] = { installed: true };

  process.on("warning", (warning: Warning) => {
    if (shouldIgnoreWarning(warning)) return;
    process.stderr.write(`${warning.stack ?? warning.toString()}\n`);
  });
}
