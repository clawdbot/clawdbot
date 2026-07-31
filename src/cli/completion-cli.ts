// Shell completion generation, cache writing, and install command registration.
import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { routeLogsToStderr } from "../logging/console.js";
import { formatConsoleDiagnosticLine } from "../logging/json-console-line.js";
import {
  collectShellCompletionCommandTree,
  type ShellCompletionContext,
} from "./completion-command-tree.js";
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

// Aliases are typeable command words; every completion surface must offer them
// alongside the canonical name or advertised commands appear nonexistent.
function commandNameVariants(cmd: Command): string[] {
  return [cmd.name(), ...cmd.aliases()];
}

function generateFishPathHelper(rootCmd: string, contexts: ShellCompletionContext[]): string {
  const knownCommandPaths = contexts
    .flatMap((context) => context.pathVariants)
    .map((pathSegments) => `'${pathSegments.join(" ").replaceAll("'", "'\\''")}'`)
    .join(" ");
  const rejectDescendantCommands = knownCommandPaths
    ? `
  if test (count $command_tokens) -gt (count $expected)
    set -l next_index (math (count $expected) + 1)
    set -l candidate_path (string join " " $expected $command_tokens[$next_index])
    switch "$candidate_path"
      case ${knownCommandPaths}
        return 1
    end
  end`
    : "";
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
  if test (count $expected) -gt 0
    for i in (seq (count $expected))
      if test "$command_tokens[$i]" != "$expected[$i]"
        return 1
      end
    end
  end
${rejectDescendantCommands}
  return 0
end
`;
}

function fishCommandPathCondition(
  rootCmd: string,
  parents: readonly string[],
  valueOptions: readonly string[],
): string {
  const commandPath = parents.length > 0 ? ` ${parents.join(" ")}` : "";
  return `__${rootCmd}_command_path_matches${commandPath} -- ${fishWords(valueOptions)}`.trimEnd();
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
  const diagnostic = `[completion] ${message}`;
  process.stderr.write(`${formatConsoleDiagnosticLine({ level: "warn", message: diagnostic })}\n`);
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

      // Cached installation needs only the existing script; loading the command tree can
      // introduce unrelated plugin failures before the cache can be checked or installed.
      if (options.install && !options.writeState) {
        const targetShell = options.shell ?? resolveShellFromEnv();
        await installCompletion(targetShell, Boolean(options.yes), program.name());
        return;
      }

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
      const choices = opt.argChoices
        ?.map((choice) => escapeZshDoubleQuotedDescription(`'${choice.replaceAll("'", "'\\''")}'`))
        .join(" ");
      const argument =
        opt.required || opt.optional
          ? `${opt.optional ? "::" : ":"}${opt.attributeName()}:${choices ? `(${choices})` : ""}`
          : "";
      if (alternate) {
        return `"(${name} ${alternate})"{${name},${alternate}}"[${desc}]${argument}"`;
      }
      return `"${name}[${desc}]${argument}"`;
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
  const { root, descendants: contexts } = collectShellCompletionCommandTree(program);
  const rootCompletions = root.completions;
  const rootValueOptions = root.valueOptions;
  const commandPathUpdate = generateBashCommandPathUpdate(contexts);
  const choiceCompletion = generateBashOptionChoiceCompletion([root, ...contexts]);
  return `
_${rootCmd}_completion() {
    local cur opts command_path candidate_path value_options word flag i
    local choice_flag choice_prefix choice_completion_prefix short_group short_flag short_index
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

    choice_flag="\${COMP_WORDS[COMP_CWORD-1]}"
    choice_prefix="\${cur}"
    choice_completion_prefix=""
    if [[ "\${cur}" == --*=* ]]; then
        choice_flag="\${cur%%=*}"
        choice_prefix="\${cur#*=}"
        choice_completion_prefix="\${choice_flag}="
    elif [[ "\${choice_flag}" == "=" ]]; then
        choice_flag="\${COMP_WORDS[COMP_CWORD-2]}"
    fi
    if [[ "\${choice_flag}" == -??* && "\${choice_flag}" != --* ]]; then
        short_group="\${choice_flag#-}"
        for ((short_index = 0; short_index < \${#short_group}; short_index++)); do
            short_flag="-\${short_group:short_index:1}"
            if [[ " \${value_options} " == *" \${short_flag} "* ]]; then
                if ((short_index == \${#short_group} - 1)); then
                    choice_flag="\${short_flag}"
                fi
                break
            fi
        done
    fi
    if [[ "\${cur}" == -??* && "\${cur}" != --* ]]; then
        short_group="\${cur#-}"
        for ((short_index = 0; short_index < \${#short_group}; short_index++)); do
            short_flag="-\${short_group:short_index:1}"
            if [[ " \${value_options} " == *" \${short_flag} "* ]]; then
                choice_flag="\${short_flag}"
                choice_prefix="\${short_group:short_index+1}"
                choice_completion_prefix="-\${short_group:0:short_index+1}"
                break
            fi
        done
    fi

${choiceCompletion}
    COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}

complete -F _${rootCmd}_completion ${rootCmd}
`;
}

function generateBashOptionChoiceCompletion(contexts: ShellCompletionContext[]): string {
  const cases = contexts
    .filter(({ valueChoices }) => valueChoices.length > 0)
    .map(({ pathVariants, valueChoices }) => {
      const commandPaths = pathVariants.map((segments) => `"${segments.join(" ")}"`).join("|");
      const optionCases = valueChoices
        .map(({ flags, choices, requiresValue }) => {
          const optionFlags = flags.map((flag) => `"${flag}"`).join("|");
          const escapedChoices = choices
            .map((choice) => `'${choice.replaceAll("'", "'\\''")}'`)
            .join(" ");
          const shouldComplete = requiresValue
            ? "true"
            : `[[ -n "\${choice_completion_prefix}" || "\${choice_prefix}" != -* ]]`;
          return `            ${optionFlags})
                if ${shouldComplete}; then
                    local -a choice_values=(${escapedChoices})
                    local choice
                    for choice in "\${choice_values[@]}"; do
                        if [[ "\${choice}" == "\${choice_prefix}"* ]]; then
                            COMPREPLY+=("\${choice_completion_prefix}\${choice}")
                        fi
                    done
                    return
                fi
                ;;`;
        })
        .join("\n");
      return `        ${commandPaths})
            case "\${choice_flag}" in
${optionCases}
            esac
            ;;`;
    })
    .join("\n");
  return cases ? `    case "\${command_path}" in\n${cases}\n    esac\n` : "";
}

function generateBashCompletionContextCases(contexts: ShellCompletionContext[]): string {
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

function generateBashCommandPathUpdate(contexts: ShellCompletionContext[]): string {
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
  const completionBodies: string[] = [];
  const formatPowerShellArray = (entries: string[]) =>
    entries.length > 0
      ? `@(${entries.map((entry) => `'${entry.replaceAll("'", "''")}'`).join(",")})`
      : "@()";
  const { root, descendants: contexts } = collectShellCompletionCommandTree(program);
  const rootValueOptions = root.valueOptions;
  const commandPathCases = contexts
    .flatMap((context) =>
      context.pathVariants.map(
        (pathSegments) => `            '${pathSegments.join(" ")}' {
                $commandPath = $candidatePath
                $valueOptions = ${formatPowerShellArray(context.valueOptions)}
            }`,
      ),
    )
    .join("\n");
  const commandPathUpdate = commandPathCases
    ? `        $candidatePath = if ($commandPath -eq '') { $element } else { "$commandPath $element" }
        switch ($candidatePath) {
${commandPathCases}
        }`
    : "";

  for (const context of contexts) {
    if (context.completions.length > 0) {
      const allCompletions = formatPowerShellArray(context.completions);
      for (const pathSegments of context.pathVariants) {
        const fullPath = pathSegments.join(" ");
        if (fullPath.length === 0) {
          continue;
        }
        completionBodies.push(`
            if ($commandPath -eq '${fullPath}') {
                $completions = ${allCompletions}
                $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
                }
            }
`);
      }
    }
  }
  const rootBody = completionBodies.join("");
  const choiceCompletion = [root, ...contexts]
    .filter(({ valueChoices }) => valueChoices.length > 0)
    .flatMap(({ pathVariants, valueChoices }) =>
      pathVariants.map((pathSegments) => {
        const optionChoiceCases = valueChoices
          .map(
            ({
              flags,
              choices,
              requiresValue,
            }) => `        if ($choiceFlag -in ${formatPowerShellArray(flags)} -and (${requiresValue ? "$true" : "$choiceCompletionPrefix -ne '' -or $choicePrefix -notlike '-*'"})) {
            $escapedChoicePrefix = [WildcardPattern]::Escape($choicePrefix)
            ${formatPowerShellArray(choices)} | Where-Object { $_ -like "$escapedChoicePrefix*" } | ForEach-Object {
                $completionText = "$choiceCompletionPrefix$_"
                if ($completionText -notmatch '^[\\p{L}\\p{N}_./:=+-]+$') {
                    $completionText = "'" + $completionText.Replace("'", "''") + "'"
                }
                [System.Management.Automation.CompletionResult]::new($completionText, $_, 'ParameterValue', $_)
            }
            return
        }`,
          )
          .join("\n");
        return `    if ($commandPath -eq '${pathSegments.join(" ").replaceAll("'", "''")}') {
${optionChoiceCases}
    }`;
      }),
    )
    .join("\n");

  return `
Register-ArgumentCompleter -Native -CommandName ${rootCmd} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    
    $commandElements = $commandAst.CommandElements
    $commandPath = ""
    $valueOptions = ${formatPowerShellArray(rootValueOptions)}
    $previousElementIndex = if ($wordToComplete -eq '') { $commandElements.Count - 1 } else { $commandElements.Count - 2 }
    $previousElement = if ($previousElementIndex -ge 1) { $commandElements[$previousElementIndex].Extent.Text } else { '' }
    $choiceFlag = $previousElement
    $choicePrefix = $wordToComplete
    $choiceCompletionPrefix = ''
    if ($wordToComplete -match '^(--[^=]+)=(.*)$') {
        $choiceFlag = $Matches[1]
        $choicePrefix = $Matches[2]
        $choiceCompletionPrefix = "$choiceFlag="
    }

    # Skip option values so global and nested flags cannot hide the command path.
    for ($i = 1; $i -lt $commandElements.Count; $i++) {
        $element = $commandElements[$i].Extent.Text
        if ($i -eq $commandElements.Count - 1 -and $wordToComplete -ne "") { break }
        if ($element -like "-*") {
            $flag = ($element -split '=', 2)[0]
            if ($element -notlike '*=*' -and $valueOptions -contains $flag) {
                $i++
            }
            continue
        }

${commandPathUpdate}
    }

    if ($previousElement -match '^-[^-].+$') {
        $shortGroup = $previousElement.Substring(1)
        for ($shortIndex = 0; $shortIndex -lt $shortGroup.Length; $shortIndex++) {
            $shortFlag = "-$($shortGroup[$shortIndex])"
            if ($valueOptions -contains $shortFlag) {
                if ($shortIndex -eq $shortGroup.Length - 1) {
                    $choiceFlag = $shortFlag
                }
                break
            }
        }
    }

    if ($wordToComplete -match '^-[^-].+$') {
        $shortGroup = $wordToComplete.Substring(1)
        for ($shortIndex = 0; $shortIndex -lt $shortGroup.Length; $shortIndex++) {
            $shortFlag = "-$($shortGroup[$shortIndex])"
            if ($valueOptions -contains $shortFlag) {
                $choiceFlag = $shortFlag
                $choicePrefix = $shortGroup.Substring($shortIndex + 1)
                $choiceCompletionPrefix = "-$($shortGroup.Substring(0, $shortIndex + 1))"
                break
            }
        }
    }

${choiceCompletion}
    
    # Root command
    if ($commandPath -eq "") {
         $completions = ${formatPowerShellArray(root.completions)}
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
  const { root, descendants } = collectShellCompletionCommandTree(program);
  const segments: string[] = [generateFishPathHelper(rootCmd, descendants)];

  for (const context of [root, ...descendants]) {
    const cmd = context.command;
    // One condition per alias-expanded parent path so completion keeps working
    // after the user typed an alias segment.
    const conditions = context.pathVariants.map((parents) =>
      fishCommandPathCondition(rootCmd, parents, context.valueOptions),
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
            requiresValue: opt.required,
            choices: opt.argChoices,
          }),
        );
      }
    }
  }
  return segments.join("");
}
