// Bash completion owns shell-word normalization and Readline insertion spans.
import type { Command } from "commander";
import {
  collectShellCompletionCommandTree,
  type ShellCompletionContext,
} from "./completion-command-tree.js";
import { quoteCliArg } from "./quote-cli-arg.js";

export function generateBashCompletion(program: Command): string {
  const rootCmd = program.name();
  const { root, descendants: contexts } = collectShellCompletionCommandTree(program);
  const commandPathUpdate = generateBashCommandPathUpdate(contexts);
  const choiceCompletion = generateBashOptionChoiceCompletion([root, ...contexts]);
  return `
_${rootCmd}_completion() {
    local cur opts command_path candidate_path value_options word flag i j cword remaining_line word_prefix
    local character next_character quote
    local choice_flag choice_prefix choice_completion_prefix short_group short_flag short_index
    local -a words=()
    # Before Bash 4.3, COMP_POINT is a byte offset; string spans must use the same units.
    if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3))); then
        local LC_ALL=C
    fi
    COMPREPLY=()
    remaining_line="\${COMP_LINE}"
    # Rejoin '=' and ':' wordbreaks, preserving redirections and whitespace boundaries.
    # Bash versions split '=' differently; $2 remains the fragment Readline will replace.
    for ((i = 0; i <= COMP_CWORD; i++)); do
        word="\${COMP_WORDS[i]}"
        if ((i > 0)) && [[ -n "\${word}" && "\${remaining_line}" == "\${word}"* &&
            ( "\${word}" =~ ^[=:]+$ || "\${COMP_WORDS[i-1]}" =~ ^[=:]+$ ) ]]; then
            words[\${#words[@]}-1]+="\${word}"
        else
            words+=("\${word}")
        fi
        remaining_line="\${remaining_line#*"\${word}"}"
    done
    cword=$((\${#words[@]} - 1))
    cur="\${words[cword]}"
    # COMP_WORDS includes text after the cursor; only the prefix participates in completion.
    cur="\${cur:0:\${#cur} + COMP_POINT - \${#COMP_LINE} + \${#remaining_line}}"
    word_prefix="\${cur%"$2"}"
    # Normalize words and the replacement prefix together: Readline keeps quoting
    # in COMP_WORDS, while its replacement span can start inside that quoted word.
    words[cword]="\${cur}"
    words+=("\${word_prefix}")
    for ((i = 0; i < \${#words[@]}; i++)); do
        word="\${words[i]}"
        words[i]=""
        quote=""
        for ((j = 0; j < \${#word}; j++)); do
            character="\${word:j:1}"
            if [[ $character == \\\\ && $quote != "'" ]]; then
                next_character="\${word:j+1:1}"
                if [[ -z $quote || $next_character == [\\\\\\$\\"\\\`] || $next_character == $'\\n' ]]; then
                    j=$((j + 1))
                    [[ $next_character == $'\\n' ]] || words[i]+="$next_character"
                    continue
                fi
            elif [[ $character == "$quote" ]]; then
                quote=""
                continue
            elif [[ -z $quote && $character == [\\'\\"] ]]; then
                quote="$character"
                continue
            fi
            words[i]+="$character"
        done
    done
    cur="\${words[cword]}"
    word_prefix="\${words[cword+1]}"
    opts="${root.completions.join(" ")}"
    value_options="${root.valueOptions.join(" ")}"
    command_path=""

    for ((i = 1; i < cword; i++)); do
        word="\${words[i]}"
        if [[ \${word} == -* ]]; then
            flag="\${word%%=*}"
            if [[ \${word} != *=* && " \${value_options} " == *" \${flag} "* ]]; then
                i=$((i + 1))
            fi
            continue
        fi

        candidate_path="\${command_path:+\${command_path} }\${word}"
${commandPathUpdate}
    done

    choice_flag="\${words[cword-1]}"
    choice_prefix="\${cur}"
    choice_completion_prefix=""
    if [[ "\${cur}" == --*=* ]]; then
        choice_flag="\${cur%%=*}"
        choice_prefix="\${cur#*=}"
        choice_completion_prefix="\${choice_flag}="
    fi
    for short_group in "\${choice_flag}" "\${cur}"; do
        [[ "\${short_group}" == -??* && "\${short_group}" != --* ]] || continue
        short_group="\${short_group#-}"
        for ((short_index = 0; short_index < \${#short_group}; short_index++)); do
            short_flag="-\${short_group:short_index:1}"
            if [[ " \${value_options} " == *" \${short_flag} "* ]]; then
                if [[ "\${cur}" == "-\${short_group}" ]]; then
                    choice_flag="\${short_flag}"
                    choice_prefix="\${short_group:short_index+1}"
                    choice_completion_prefix="-\${short_group:0:short_index+1}"
                elif ((short_index == \${#short_group} - 1)); then
                    choice_flag="\${short_flag}"
                fi
                break
            fi
        done
    done

${choiceCompletion}
    COMPREPLY=( $(compgen -W "\${opts}" -- "\${cur}") )
    COMPREPLY=("\${COMPREPLY[@]#"\${word_prefix}"}")
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
          const escapedChoices = choices.map(quoteCliArg).join(" ");
          const shouldReturn = requiresValue
            ? "true"
            : `[[ \${#COMPREPLY[@]} -gt 0 || -n "\${choice_completion_prefix}" || "\${choice_prefix}" != -* ]]`;
          return `            ${optionFlags})
                local -a choice_values=(${escapedChoices})
                local choice completion
                for choice in "\${choice_values[@]}"; do
                    if [[ "\${choice}" == "\${choice_prefix}"* ]]; then
                        completion="\${choice_completion_prefix}\${choice}"
                        COMPREPLY+=("\${completion#"\${word_prefix}"}")
                    fi
                done
                if ${shouldReturn}; then
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

function generateBashCommandPathUpdate(contexts: ShellCompletionContext[]): string {
  const cases = contexts.map((context) => {
    const patterns = context.pathVariants
      .map((commandPath) => `"${commandPath.join(" ")}"`)
      .join("|");
    return `          ${patterns})
            command_path="\${candidate_path}"
            opts="${context.completions.join(" ")}"
            value_options="${context.valueOptions.join(" ")}"
            ;;`;
  });
  return cases.length
    ? `        case "\${candidate_path}" in\n${cases.join("\n")}\n        esac`
    : "";
}
