/**
 * Test helpers for inspecting Docker command arguments.
 *
 * These stay local to sandbox tests so production code does not grow ad-hoc
 * argument parsing utilities.
 */
/** Finds the first mocked Docker call whose argv starts with the requested command. */
export function findDockerArgsCall(calls: unknown[][], command: string): string[] | undefined {
  return calls.find((call) => Array.isArray(call[0]) && call[0][0] === command)?.[0] as
    | string[]
    | undefined;
}

/** Collects every value passed after a repeated Docker flag. */
export function collectDockerFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (const [i, arg] of args.entries()) {
    const value = args.at(i + 1);
    if (arg === flag && value !== undefined) {
      values.push(value);
    }
  }
  return values;
}
