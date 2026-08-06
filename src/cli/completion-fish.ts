// Fish completion line builders for subcommands and options.
function escapeFishDescription(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function quoteFishCompletionChoice(value: string): string {
  // Fish evaluates -a expressions during completion; single quotes keep choices as inert values.
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function escapeFishDoubleQuotedArgument(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
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
  requiresValue?: boolean;
  choices?: readonly string[];
}): string {
  const desc = escapeFishDescription(params.description);
  const choices = params.choices?.length
    ? escapeFishDoubleQuotedArgument(params.choices.map(quoteFishCompletionChoice).join(" "))
    : undefined;
  let line = `complete -c ${params.rootCmd} -n "${params.condition}"`;
  for (const flag of params.flags) {
    line += flag.startsWith("--") ? ` -l ${flag.slice(2)}` : ` -s ${flag.slice(1)}`;
  }
  if (params.requiresValue) {
    line += " -r";
  }
  if (choices) {
    line += ` -f -a "${choices}"`;
  }
  line += ` -d '${desc}'\n`;
  if (choices && !params.requiresValue) {
    // Fish only binds separated values to required options; keep Commander optional values optional.
    const pendingOption = `contains -- (commandline -opc)[-1] ${params.flags.join(" ")}`;
    line += `complete -c ${params.rootCmd} -n "${params.condition}; and ${pendingOption}" -f -a "${choices}" -d '${desc}'\n`;
  }
  return line;
}
