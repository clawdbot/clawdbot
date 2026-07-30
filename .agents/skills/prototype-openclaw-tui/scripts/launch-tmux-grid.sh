#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [--open | --refresh] <session> <cwd> <title> <command> [<title> <command> ...]" >&2
  exit 2
}

open_external_terminal() {
  local session_name=$1
  local system_name
  system_name=$(uname -s)

  if [[ $system_name == "Darwin" ]] && command -v open >/dev/null 2>&1; then
    local attach_dir attach_command terminal_app tmux_path
    attach_dir=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-tui-prototype.XXXXXX")
    attach_command="$attach_dir/attach.command"
    printf '#!/usr/bin/env bash\nattach_file=$0\nrm -f -- "$attach_file"\nrmdir -- "$(dirname "$attach_file")" 2>/dev/null || true\nexec tmux attach-session -t %q\n' \
      "$session_name" >"$attach_command"
    chmod +x "$attach_command"

    terminal_app=""
    if command -v osascript >/dev/null 2>&1; then
      terminal_app=$(osascript -l JavaScript \
        -e 'function run(argv) { ObjC.import("AppKit"); ObjC.import("Foundation"); const file = $.NSURL.fileURLWithPath(argv[0]); const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(file); return app ? ObjC.unwrap(app.path) : ""; }' \
        "$attach_command" 2>/dev/null || true)
    fi

    # Ghostty 1.3 drops the leading slash when LaunchServices opens a .command
    # file. Use its documented command entry point while preserving the user's
    # .command association as the source of truth for their terminal choice.
    if [[ $terminal_app == */Ghostty.app ]]; then
      tmux_path=$(command -v tmux)
      if open -n -a "$terminal_app" --args -e \
        "$tmux_path" attach-session -t "$session_name"; then
        rm -f -- "$attach_command"
        rmdir -- "$attach_dir" 2>/dev/null || true
        return 0
      fi
    fi

    if open "$attach_command"; then
      return 0
    fi
    rm -f -- "$attach_command"
    rmdir -- "$attach_dir" 2>/dev/null || true
    return 1
  fi

  if [[ $system_name == "Linux" && -n ${WSL_DISTRO_NAME:-} ]] &&
    command -v wt.exe >/dev/null 2>&1; then
    if wt.exe new-tab --title "OpenClaw TUI prototypes" \
      wsl.exe --distribution "$WSL_DISTRO_NAME" --exec \
      tmux attach-session -t "$session_name"; then
      return 0
    fi
  fi

  if [[ $system_name == "Linux" ]]; then
    if command -v xdg-terminal-exec >/dev/null 2>&1; then
      if xdg-terminal-exec --title="OpenClaw TUI prototypes" \
        tmux attach-session -t "$session_name"; then
        return 0
      fi
    fi

    if [[ -n ${TERMINAL:-} ]] && command -v "$TERMINAL" >/dev/null 2>&1; then
      if "$TERMINAL" -e tmux attach-session -t "$session_name"; then
        return 0
      fi
    fi

    if command -v x-terminal-emulator >/dev/null 2>&1; then
      if x-terminal-emulator -e tmux attach-session -t "$session_name"; then
        return 0
      fi
    fi
  fi

  return 1
}

open_external=false
refresh_session=false
while [[ ${1:-} == --* ]]; do
  case $1 in
    --open)
      open_external=true
      ;;
    --refresh)
      refresh_session=true
      ;;
    *)
      usage
      ;;
  esac
  shift
done

if [[ $open_external == true && $refresh_session == true ]]; then
  echo "--refresh reuses the attached terminal and cannot be combined with --open" >&2
  exit 2
fi

if (( $# < 4 || ($# - 2) % 2 != 0 )); then
  usage
fi

session_name=$1
prototype_cwd=$2
shift 2

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required" >&2
  exit 1
fi
if [[ ! -d $prototype_cwd ]]; then
  echo "working directory does not exist: $prototype_cwd" >&2
  exit 1
fi
session_exists=false
if tmux has-session -t "$session_name" 2>/dev/null; then
  session_exists=true
fi
if [[ $refresh_session == true && $session_exists == false ]]; then
  echo "tmux session does not exist: $session_name" >&2
  echo "create it first with --open" >&2
  exit 1
fi
if [[ $refresh_session == false && $session_exists == true ]]; then
  echo "tmux session already exists: $session_name" >&2
  echo "attach with: tmux attach-session -t '$session_name'" >&2
  echo "refresh it with: $0 --refresh '$session_name' '$prototype_cwd' ..." >&2
  exit 1
fi

pane_titles=()
pane_commands=()
while (( $# > 0 )); do
  pane_titles[${#pane_titles[@]}]=$1
  pane_commands[${#pane_commands[@]}]=$2
  shift 2
done

pane_command_prefix=(/bin/sh -c)
if [[ ${TERM:-} == "dumb" && -n ${NO_COLOR:-} ]]; then
  pane_command_prefix=(env -u NO_COLOR /bin/sh -c)
fi

if [[ $refresh_session == true ]]; then
  if ! tmux display-message -p -t "$session_name:prototypes" '#{window_id}' >/dev/null 2>&1; then
    echo "tmux session has no prototypes window: $session_name" >&2
    exit 1
  fi

  pane_ids=()
  while IFS= read -r pane_id; do
    pane_ids[${#pane_ids[@]}]=$pane_id
  done < <(tmux list-panes -t "$session_name:prototypes" -F '#{pane_id}')
  first_pane=${pane_ids[0]}
  tmux select-pane -t "$first_pane"
  for ((index = ${#pane_ids[@]} - 1; index >= 1; index--)); do
    tmux kill-pane -t "${pane_ids[index]}"
  done

  tmux respawn-pane -k -t "$first_pane" -c "$prototype_cwd" \
    "${pane_command_prefix[@]}" "${pane_commands[0]}"
  tmux select-pane -t "$first_pane" -T "${pane_titles[0]}"
  last_pane=$first_pane
  for ((index = 1; index < ${#pane_commands[@]}; index++)); do
    pane_id=$(tmux split-window -d -v -P -F '#{pane_id}' \
      -t "$last_pane" -c "$prototype_cwd" \
      "${pane_command_prefix[@]}" "${pane_commands[index]}")
    tmux select-pane -t "$pane_id" -T "${pane_titles[index]}"
    last_pane=$pane_id
    # Rebalance after every split so larger grids do not exhaust the last
    # vertically chained pane before the final tiled layout is applied.
    tmux select-layout -t "$session_name:prototypes" tiled >/dev/null
  done
else
  created_session=false
  cleanup_partial_session() {
    if [[ $created_session == true ]] && tmux has-session -t "$session_name" 2>/dev/null; then
      tmux kill-session -t "$session_name"
    fi
  }
  trap cleanup_partial_session ERR

  first_pane=$(tmux new-session -d -P -F '#{pane_id}' \
    -s "$session_name" -n prototypes -c "$prototype_cwd" \
    "${pane_command_prefix[@]}" "${pane_commands[0]}")
  created_session=true
  tmux select-pane -t "$first_pane" -T "${pane_titles[0]}"
  last_pane=$first_pane
  for ((index = 1; index < ${#pane_commands[@]}; index++)); do
    pane_id=$(tmux split-window -d -v -P -F '#{pane_id}' \
      -t "$last_pane" -c "$prototype_cwd" \
      "${pane_command_prefix[@]}" "${pane_commands[index]}")
    tmux select-pane -t "$pane_id" -T "${pane_titles[index]}"
    last_pane=$pane_id
    tmux select-layout -t "$session_name:prototypes" tiled >/dev/null
  done
fi

tmux set-option -t "$session_name" mouse on
tmux set-option -t "$session_name" status-left " TUI PROTOTYPES "
tmux set-option -t "$session_name" status-right "Ctrl-b z: zoom"
tmux set-option -t "$session_name" pane-border-status top
tmux set-option -t "$session_name" pane-border-format ' #[bold]#{pane_title} #[default]'
tmux set-window-option -t "$session_name:prototypes" allow-rename off
tmux set-window-option -t "$session_name:prototypes" automatic-rename off
tmux set-window-option -t "$session_name:prototypes" remain-on-exit on
tmux select-layout -t "$session_name:prototypes" tiled >/dev/null
tmux select-pane -t "$first_pane"

trap - ERR
if [[ $refresh_session == true ]]; then
  echo "tmux session refreshed: $session_name"
else
  echo "tmux session ready: $session_name"
fi
echo "attach with: tmux attach-session -t '$session_name'"

if [[ $open_external == true ]]; then
  if ! open_external_terminal "$session_name"; then
    echo "could not open an external terminal; attach manually with:" >&2
    printf "  tmux attach-session -t %q\n" "$session_name" >&2
  fi
fi
