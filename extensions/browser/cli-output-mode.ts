import { consumeRootOptionToken } from "openclaw/plugin-sdk/cli-argv";

const BROWSER_BOOLEAN_OPTIONS = new Set(["--json", "--expect-final"]);
const BROWSER_VALUE_OPTIONS = new Set([
  "--browser-profile",
  "--url",
  "--token",
  "--timeout",
  "--gateway-url",
]);

function isValueToken(arg: string | undefined): boolean {
  return Boolean(arg && arg !== "--" && (!arg.startsWith("-") || /^-\d+(?:\.\d+)?$/.test(arg)));
}

function consumeOption(
  args: readonly string[],
  index: number,
  booleanOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): number {
  const arg = args[index];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (booleanOptions.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!valueOptions.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return isValueToken(args[index + 1]) ? 2 : 1;
}

function resolveBrowserCommandPath(argv: readonly string[]): string[] {
  const args = argv.slice(2);
  let sawBrowser = false;
  const commandPath: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      break;
    }
    if (!sawBrowser) {
      const consumed = consumeRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg === "browser") {
        sawBrowser = true;
      }
      continue;
    }
    const rootConsumed = consumeRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    const consumed = consumeOption(args, index, BROWSER_BOOLEAN_OPTIONS, BROWSER_VALUE_OPTIONS);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      break;
    }
    commandPath.push(arg);
  }
  return commandPath;
}

export function resolveBrowserLazySubcommand(argv: readonly string[]): string | null {
  return resolveBrowserCommandPath(argv)[0] ?? null;
}

/** Browser inspection commands with JSON as their default presentation own machine stdout. */
export function isBrowserMachineOutput(params: { argv: readonly string[] }): boolean {
  const path = resolveBrowserCommandPath(params.argv);
  return (
    path[0] === "evaluate" ||
    path[0] === "console" ||
    (path[0] === "cookies" && path.length === 1) ||
    (path[0] === "storage" && ["local", "session"].includes(path[1] ?? "") && path[2] === "get") ||
    (path[0] === "extension" && path[1] === "native-host") ||
    (path[0] === "extension" &&
      ["install", "status", "uninstall-host", "pair", "cdp"].includes(path[1] ?? "") &&
      params.argv.includes("--json"))
  );
}
