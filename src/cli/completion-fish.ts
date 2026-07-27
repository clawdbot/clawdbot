// Fish completion line builders for subcommands and options.
function escapeFishDescription(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function buildFishSubcommandCompletionLine(params: {
  rootCmd: string;
  condition: string;
  name: string;
  description: string;
}): string {
  const desc = escapeFishDescription(params.description);
  return `complete -c ${params.rootCmd} -n "${params.condition}" -a "${params.name}" -d '${desc}'\n`;
}

export function buildFishOptionCompletionLine(params: {
  rootCmd: string;
  condition: string;
  flags: readonly string[];
  description: string;
}): string {
  const desc = escapeFishDescription(params.description);
  let line = `complete -c ${params.rootCmd} -n "${params.condition}"`;
  for (const flag of params.flags) {
    line += flag.startsWith("--") ? ` -l ${flag.slice(2)}` : ` -s ${flag.slice(1)}`;
  }
  line += ` -d '${desc}'\n`;
  return line;
}
