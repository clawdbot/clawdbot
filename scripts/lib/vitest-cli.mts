import { VITEST_SUBCOMMANDS } from "./vitest-cli-mode.mts";

function nativeHelpRequested(args: string[], parseCLI: typeof import("vitest/node").parseCLI) {
  const controls: string[] = [];
  for (const [index, original] of args.entries()) {
    if (original === "--") {
      break;
    }
    // CAC treats every prefix except exactly two dashes as a short-option group.
    const arg = original.replace(/^---+/u, "-");
    // Project only help onto native watch's boolean/short-alias grammar.
    // parseCLI(help) prints and skips validation; only the real child may do that.
    const projected = arg.startsWith("--")
      ? arg.replace(
          /^--(no-)?(help|h)(?=[.=]|$)/u,
          (_, no: string | undefined, name: string) =>
            `--${no ?? ""}${name === "h" ? "w" : "watch"}`,
        )
      : arg.startsWith("-no-")
        ? arg.replace(/^-no-(help|h)$/u, (_, name: string) =>
            name === "h" ? "-no-w" : "-no-watch",
          )
        : arg.replace(
            /^-(?!-)([^=]+)/u,
            (_, flags: string) => `-${flags.replace(/[^h]/gu, "x").replaceAll("h", "w")}`,
          );
    if (projected === arg || !/watch|w/u.test(projected)) {
      continue;
    }
    controls.push(projected);
    const value = args[index + 1];
    if (value && !value.startsWith("-")) {
      controls.push(value);
    }
  }
  return Boolean(
    parseCLI(["vitest", "run", ...controls], { allowUnknownOptions: true }).options.watch,
  );
}

/** Validate admission without printing help/version or taking the real child's error ownership. */
export function parseVitestExecutionArgs(
  args: string[],
  parseCLI: typeof import("vitest/node").parseCLI,
) {
  try {
    if (nativeHelpRequested(args, parseCLI)) {
      return null;
    }
    // The silent run prefix lets native operand parsing expose the original first
    // positional; dotted booleans must not consume a real command such as run.
    const probe = parseCLI(["vitest", "run", ...args], { allowUnknownOptions: true });
    const command = probe.filter[0];
    const namedCommand = command !== undefined && VITEST_SUBCOMMANDS.has(command);
    if (
      command === "list" ||
      command === "init" ||
      (!namedCommand && "version" in probe.options && probe.options.version)
    ) {
      return null;
    }
    // Unlike --run --version, a named run with --version executes tests.
    const parsed = parseCLI(["vitest", ...(namedCommand ? [] : ["run"]), ...args]);
    const { options, filter } = parsed;
    if (
      options.listTags ||
      options.clearCache ||
      options.mergeReports ||
      (options.standalone && !filter.length)
    ) {
      return null;
    }
    return parsed;
  } catch {
    // Repeated help is truthy to CAC but the projection rejects repeated scalars.
    // That and native invalid input must reach the real child without preparing builds.
    return null;
  }
}
