export function readControlUiProofOption(
  argv: readonly string[],
  name: string,
): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
