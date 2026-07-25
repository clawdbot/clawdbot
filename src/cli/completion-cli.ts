// Shell completion generation, cache writing, and install command registration.
import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { routeLogsToStderr } from "../logging/console.js";
import {
  buildFishOptionCompletionLine,
  buildFishSubcommandCompletionLine,
} from "./completion-fish.js";
import {
  COMPLETION_SHELLS,
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
  installCompletion,
  isCompletionShell,
  resolveCompletionCachePath,
  resolveShellFromEnv,
  type CompletionShell,
} from "./completion-runtime.js";
import { getCoreCliCommandNames, registerCoreCliByName } from "./program/command-registry-core.js";
import { getProgramContext } from "./program/program-context.js";
import { getSubCliEntries, registerSubCliByName } from "./program/register.subclis-core.js";

export function getCompletionScript(shell: CompletionShell, program: Command): string {
  if (shell === "zsh") {
    return generateZshCompletion(program);
  }
  if (shell === "bash") {
    return generateBashCompletion(program);
  }
  if (shell === "powershell") {
    return generatePowerShellCompletion(program);
  }
  return generateFishCompletion(program);
}

function completionFlags(option: Option): string[] {
  return [option.short, option.long].filter((flag): flag is string => Boolean(flag));
}

function preferredCompletionFlag(option: Option): string {
  return option.long ?? option.short ?? option.flags;
}

function fishWords(values: readonly string[]): string {
  return values.join(" ");
}

function completionOptionFlags(options: Command["options"], wantsValue: boolean): string[] {
  return options.flatMap((option) => {
    if ((option.required || option.optional) !== wantsValue) {
      return [];
    }
    return completionFlags(option);
  });
}

// Aliases are typeable command words; every completion surface must offer them
// alongside the canonical name or advertised commands appear nonexistent.
function commandNameVariants(cmd: Command): string[] {
  return [cmd.name(), ...cmd.aliases()];
}

// Alias-typed paths must keep completing like the canonical command. Variants
// multiply by (1 + alias count) per aliased ancestor, so nesting aliased
// commands under each other grows emitted paths multiplicatively; today no
// aliased command nests under another.
function childPathVariants(parentVariants: readonly string[][], sub: Command): string[][] {
  return parentVariants.flatMap((parents) =>
    commandNameVariants(sub).map((name) => parents.concat(name)),
  );
}

function collectFishPathOptionFlags(
  program: Command,
  parents: readonly string[],
  wantsValue: boolean,
): string[] {
  const flags = new Set(completionOptionFlags(program.options, wantsValue));
  let current: Command | undefined = program;
  for (const name of parents) {
    // Path segments can be aliases when the user typed one; resolve both forms.
    current = current?.commands.find((cmd) => commandNameVariants(cmd).includes(name));
    if (!current) {
      break;
    }
    for (const flag of completionOptionFlags(current.options, wantsValue)) {
      flags.add(flag);
    }
  }
  return [...flags];
}

function generateFishPathHelper(rootCmd: string): string {
  // Fish needs a helper to ignore option values while matching nested command paths.
  return `
function __${rootCmd}_command_path_matches
  set -l expected
  set -l value_options
  set -l reading_value_options 0
  for arg in $argv
    if test "$arg" = "--"
      set reading_value_options 1
      continue
    end
    if test $reading_value_options -eq 1
      set -a value_options $arg
    else
      set -a expected $arg
    end
  end
  set -l tokens (commandline -opc)
  set -e tokens[1]
  set -l command_tokens
  set -l skip_next 0
  for token in $tokens
    if test $skip_next -eq 1
      set skip_next 0
      continue
    end
    set -l flag (string split -m1 "=" -- $token)[1]
    if contains -- $flag $value_options
      if not string match -q -- "*=*" $token
        set skip_next 1
      end
      continue
    end
    if string match -q -- "-*" $token
      continue
    end
    set -a command_tokens $token
  end
  for i in (seq (count $expected))
    if test "$command_tokens[$i]" != "$expected[$i]"
      return 1
    end
  end
  return 0
end
`;
}

function fishCommandPathCondition(
  program: Command,
  rootCmd: string,
  parents: readonly string[],
): string {
  const valueOptions = collectFishPathOptionFlags(program, parents, true);
  return `__${rootCmd}_command_path_matches ${parents.join(" ")} -- ${fishWords(valueOptions)}`.trimEnd();
}

async function writeCompletionCache(params: {
  program: Command;
  shells: CompletionShell[];
  binName: string;
}): Promise<void> {
  const firstShell = params.shells[0] ?? "zsh";
  const cacheDir = path.dirname(resolveCompletionCachePath(firstShell, params.binName));
  await fs.mkdir(cacheDir, { recursive: true });
  for (const shell of params.shells) {
    const script = getCompletionScript(shell, params.program);
    const targetPath = resolveCompletionCachePath(shell, params.binName);
    await fs.writeFile(targetPath, script, "utf-8");
  }
}

function writeCompletionRegistrationWarning(message: string): void {
  process.stderr.write(`[completion] ${message}\n`);
}

async function registerSubcommandsForCompletion(program: Command): Promise<void> {
  const entries = getSubCliEntries();
  for (const entry of entries) {
    if (entry.name === "completion") {
      continue;
    }
    try {
      await registerSubCliByName(program, entry.name, process.argv, { purpose: "completion" });
    } catch (error) {
      writeCompletionRegistrationWarning(
        `skipping subcommand \`${entry.name}\` while building completion cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function registerCompletionCli(program: Command) {
  program
    .command("completion")
    .description("Generate shell completion script")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/completion", "docs.openclaw.ai/cli/completion")}\n`,
    )
    .addOption(
      new Option("-s, --shell <shell>", "Shell to generate completion for (default: zsh)").choices(
        COMPLETION_SHELLS,
      ),
    )
    .option("-i, --install", "Install completion script to shell profile")
    .option(
      "--write-state",
      "Write completion scripts to $OPENCLAW_STATE_DIR/completions (no stdout)",
    )
    .option("-y, --yes", "Skip confirmation (non-interactive)", false)
    .action(async (options) => {
      // Route logs to stderr so plugin loading messages do not corrupt
      // the completion script written to stdout.
      routeLogsToStderr();
      const shell = options.shell ?? "zsh";

      // Completion needs the full Commander command tree (including nested subcommands).
      // Our CLI defaults to lazy registration for perf; force-register core commands here.
      const ctx = getProgramContext(program);
      if (ctx) {
        for (const name of getCoreCliCommandNames()) {
          await registerCoreCliByName(program, ctx, name);
        }
      }

      // Eagerly register all subcommands except completion itself to build the full tree.
      await registerSubcommandsForCompletion(program);

      if (process.env[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV] !== "1") {
        const { registerPluginCliCommandsFromValidatedConfig } = await import("../plugins/cli.js");
        await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
          mode: "eager",
        });
      }

      if (options.writeState) {
        const writeShells = options.shell ? [shell] : [...COMPLETION_SHELLS];
        await writeCompletionCache({
          program,
          shells: writeShells,
          binName: program.name(),
        });
      }

      if (options.install) {
        const targetShell = options.shell ?? resolveShellFromEnv();
        await installCompletion(targetShell, Boolean(options.yes), program.name());
        return;
      }

      if (options.writeState) {
        return;
      }

      if (!isCompletionShell(shell)) {
        throw new Error(`Unsupported shell: ${shell}`);
      }
      const script = getCompletionScript(shell, program);
      process.stdout.write(script + "\n");
    });
}

function generateZshCompletion(program: Command): string {
  const rootCmd = program.name();
  const script = `
#compdef ${rootCmd}

_${rootCmd}_root_completion() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(program)} \\
    ${generateZshSubcmdList(program)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${program.commands.map((cmd) => `(${commandNameVariants(cmd).join("|")}) _${rootCmd}_${cmd.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}

${generateZshSubcommands(program, rootCmd)}

_${rootCmd}_register_completion() {
  if (( ! $+functions[compdef] )); then
    return 0
  fi

  compdef _${rootCmd}_root_completion ${rootCmd}
  precmd_functions=(\${precmd_functions:#_${rootCmd}_register_completion})
  unfunction _${rootCmd}_register_completion 2>/dev/null
}

_${rootCmd}_register_completion
if (( ! $+functions[compdef] )); then
  typeset -ga precmd_functions
  if [[ -z "\${precmd_functions[(r)_${rootCmd}_register_completion]}" ]]; then
    precmd_functions+=(_${rootCmd}_register_completion)
  fi
fi
`;
  return script;
}

function generateZshArgs(cmd: Command): string {
  return (cmd.options || [])
    .map((opt) => {
      const flags = completionFlags(opt);
      const name = preferredCompletionFlag(opt);
      const alternate = flags.find((flag) => flag !== name);
      const desc = escapeZshDoubleQuotedDescription(opt.description);
      if (alternate) {
        return `"(${name} ${alternate})"{${name},${alternate}}"[${desc}]"`;
      }
      return `"${name}[${desc}]"`;
    })
    .join(" \\\n    ");
}

function generateZshSubcmdList(cmd: Command): string {
  const list = cmd.commands
    .flatMap((c) => {
      const desc = c
        .description()
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "'\\''")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
      return commandNameVariants(c).map((name) => `'${name}[${desc}]'`);
    })
    .join(" ");
  return `"1: :_values 'command' ${list}"`;
}

function escapeZshDoubleQuotedDescription(description: string): string {
  return description
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replaceAll("`", "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function generateZshSubcommands(program: Command, prefix: string): string {
  const segments: string[] = [];

  const visit = (current: Command, currentPrefix: string) => {
    for (const cmd of current.commands) {
      const cmdName = cmd.name();
      const nextPrefix = `${currentPrefix}_${cmdName.replace(/-/g, "_")}`;
      const funcName = `_${nextPrefix}`;

      visit(cmd, nextPrefix);

      const subCommands = cmd.commands;
      if (subCommands.length > 0) {
        segments.push(`
${funcName}() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(cmd)} \\
    ${generateZshSubcmdList(cmd)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${subCommands.map((sub) => `(${commandNameVariants(sub).join("|")}) ${funcName}_${sub.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}
`);
        continue;
      }

      segments.push(`
${funcName}() {
  _arguments -C \\
    ${generateZshArgs(cmd)}
}
`);
    }
  };

  visit(program, prefix);
  return segments.join("");
}

function generateBashCompletion(program: Command): string {
  const rootCmd = program.name();
  const rootCompletions = [
    ...program.commands.flatMap((command) => commandNameVariants(command)),
    ...program.options.map((option) => preferredCompletionFlag(option)),
  ];
  const rootValueOptions = completionOptionFlags(program.options, true);
  const contexts = collectBashCompletionContexts(program, rootValueOptions);
  const commandPathUpdate = generateBashCommandPathUpdate(contexts);
  return `
_${rootCmd}_completion() {
    local cur opts command_path candidate_path value_options word flag i
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    opts="${rootCompletions.join(" ")}"
    value_options="${rootValueOptions.join(" ")}"
    command_path=""

    for ((i = 1; i < COMP_CWORD; i++)); do
        word="\${COMP_WORDS[i]}"
        if [[ \${word} == -* ]]; then
            flag="\${word%%=*}"
            if [[ \${word} != *=* && " \${value_options} " == *" \${flag} "* ]]; then
                i=$((i + 1))
            fi
            continue
        fi

        if [[ -n "\${command_path}" ]]; then
            candidate_path="\${command_path} \${word}"
        else
            candidate_path="\${word}"
        fi

${commandPathUpdate}
    done

    COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}

complete -F _${rootCmd}_completion ${rootCmd}
`;
}

type BashCompletionContext = {
  pathVariants: string[][];
  completions: string[];
  valueOptions: string[];
};

function collectBashCompletionContexts(
  program: Command,
  rootValueOptions: string[],
): BashCompletionContext[] {
  const contexts: BashCompletionContext[] = [];

  const visit = (cmd: Command, pathVariants: string[][], inheritedValueOptions: string[]) => {
    const completions = [
      ...cmd.commands.flatMap((command) => commandNameVariants(command)),
      ...cmd.options.map((option) => preferredCompletionFlag(option)),
    ];
    const valueOptions = [
      ...new Set([...inheritedValueOptions, ...completionOptionFlags(cmd.options, true)]),
    ];
    contexts.push({ pathVariants, completions, valueOptions });

    for (const sub of cmd.commands) {
      visit(sub, childPathVariants(pathVariants, sub), valueOptions);
    }
  };

  for (const sub of program.commands) {
    visit(sub, childPathVariants([[]], sub), rootValueOptions);
  }

  return contexts;
}

function generateBashCompletionContextCases(contexts: BashCompletionContext[]): string {
  const segments = contexts.map((context) => {
    const patterns = context.pathVariants
      .map((commandPath) => `"${commandPath.join(" ")}"`)
      .join("|");
    return `              ${patterns})
                opts="${context.completions.join(" ")}"
                value_options="${context.valueOptions.join(" ")}"
                ;;`;
  });
  return segments.join("\n");
}

function generateBashCommandPathUpdate(contexts: BashCompletionContext[]): string {
  if (contexts.length === 0) {
    return "";
  }
  const commandPathPatterns = contexts
    .flatMap((context) => context.pathVariants)
    .map((commandPath) => `"${commandPath.join(" ")}"`)
    .join("|");
  return `        case "\${candidate_path}" in
          ${commandPathPatterns})
            command_path="\${candidate_path}"
            case "\${command_path}" in
${generateBashCompletionContextCases(contexts)}
            esac
            ;;
        esac`;
}

function generatePowerShellCompletion(program: Command): string {
  const rootCmd = program.name();
  const segments: string[] = [];
  const formatPowerShellArray = (entries: string[]) =>
    entries.length > 0 ? `@(${entries.map((entry) => `'${entry}'`).join(",")})` : "@()";

  const visit = (cmd: Command, pathVariants: string[][]) => {
    // Command completion for this level
    const subCommands = cmd.commands.flatMap((c) => commandNameVariants(c));
    const options = cmd.options.map((option) => preferredCompletionFlag(option));
    const allCompletions = formatPowerShellArray([...subCommands, ...options]);

    if ([...subCommands, ...options].length > 0) {
      for (const pathSegments of pathVariants) {
        const fullPath = pathSegments.join(" ");
        if (fullPath.length === 0) {
          continue;
        }
        segments.push(`
            if ($commandPath -eq '${fullPath}') {
                $completions = ${allCompletions}
                $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
                }
            }
`);
      }
    }

    for (const sub of cmd.commands) {
      visit(sub, childPathVariants(pathVariants, sub));
    }
  };

  visit(program, [[]]);
  const rootBody = segments.join("");

  return `
Register-ArgumentCompleter -Native -CommandName ${rootCmd} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    
    $commandElements = $commandAst.CommandElements
    $commandPath = ""
    
    # Reconstruct command path (simple approximation)
    # Skip the executable name
    for ($i = 1; $i -lt $commandElements.Count; $i++) {
        $element = $commandElements[$i].Extent.Text
        if ($element -like "-*") { break }
        if ($i -eq $commandElements.Count - 1 -and $wordToComplete -ne "") { break } # Don't include current word being typed
        $commandPath += "$element "
    }
    $commandPath = $commandPath.Trim()
    
    # Root command
    if ($commandPath -eq "") {
         $completions = ${formatPowerShellArray([
           ...program.commands.flatMap((command) => commandNameVariants(command)),
           ...program.options.map((option) => preferredCompletionFlag(option)),
         ])}
         $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
         }
    }
    
    ${rootBody}
}
`;
}

function generateFishCompletion(program: Command): string {
  const rootCmd = program.name();
  const segments: string[] = [generateFishPathHelper(rootCmd)];

  const visit = (cmd: Command, parentVariants: string[][]) => {
    // One condition per alias-expanded parent path so completion keeps working
    // after the user typed an alias segment.
    const conditions = parentVariants.map((parents) =>
      parents.length === 0
        ? "__fish_use_subcommand"
        : fishCommandPathCondition(program, rootCmd, parents),
    );
    for (const condition of conditions) {
      // Subcommands (canonical names and aliases)
      for (const sub of cmd.commands) {
        for (const name of commandNameVariants(sub)) {
          segments.push(
            buildFishSubcommandCompletionLine({
              rootCmd,
              condition,
              name,
              description: sub.description(),
            }),
          );
        }
      }
      // Options
      for (const opt of cmd.options) {
        segments.push(
          buildFishOptionCompletionLine({
            rootCmd,
            condition,
            flags: completionFlags(opt),
            description: opt.description,
          }),
        );
      }
    }

    for (const sub of cmd.commands) {
      visit(sub, childPathVariants(parentVariants, sub));
    }
  };

  visit(program, [[]]);
  return segments.join("");
}
