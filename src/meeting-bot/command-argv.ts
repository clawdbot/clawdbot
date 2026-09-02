export function splitCommandArgv(argv: readonly string[], commandLabel: string) {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error(`${commandLabel} must not be empty`);
  }
  return { command, args };
}
