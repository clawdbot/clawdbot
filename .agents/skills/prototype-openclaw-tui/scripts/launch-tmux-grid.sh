#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: $0 [--open | --refresh] <session> <cwd> <title> <command> <title> <command> [<title> <command> ...] (2-6 variants)" >&2
  exit 2
}

configure_tmux_session() {
  local session_id=$1
  local window_id=$2

  tmux set-option -t "$session_id" mouse on
  tmux set-option -t "$session_id" status-left " TUI PROTOTYPES "
  tmux set-option -t "$session_id" status-right "Ctrl-b z: zoom"
  tmux set-window-option -t "$window_id" pane-border-status top
  tmux set-window-option -t "$window_id" pane-border-format ' #[bold]#{pane_title} #[default]'
  tmux set-window-option -t "$window_id" allow-rename off
  tmux set-window-option -t "$window_id" automatic-rename off
  tmux set-window-option -t "$window_id" remain-on-exit on
}

prepare_grid_geometry() {
  local window_id=$1
  local pane_count=$2
  local window_width window_height normalized_width normalized_height

  case $pane_count in
    2)
      grid_columns=2
      grid_rows=1
      ;;
    3)
      grid_columns=3
      grid_rows=1
      ;;
    4)
      grid_columns=2
      grid_rows=2
      ;;
    5)
      grid_columns=5
      grid_rows=1
      ;;
    6)
      grid_columns=3
      grid_rows=2
      ;;
    *)
      echo "expected 2-6 prototype panes, got: $pane_count" >&2
      return 1
      ;;
  esac

  # Restore the attached session size before normalizing it so repeated
  # refreshes do not progressively shrink the prototype window.
  tmux resize-window -A -t "$window_id"
  read -r window_width window_height < <(
    tmux display-message -p -t "$window_id" '#{window_width} #{window_height}'
  )
  grid_pane_width=$(((window_width - grid_columns + 1) / grid_columns))
  # pane-border-status=top consumes the outer top line, while row separators
  # carry the remaining titles. Account for both so pane content heights match.
  grid_pane_height=$(((window_height - grid_rows) / grid_rows))
  if ((grid_pane_width < 1 || grid_pane_height < 1)); then
    echo "terminal is too small for $pane_count equal prototype panes" >&2
    return 1
  fi
  normalized_width=$((grid_pane_width * grid_columns + grid_columns - 1))
  normalized_height=$((grid_pane_height * grid_rows + grid_rows))

  tmux resize-window -t "$window_id" -x "$normalized_width" -y "$normalized_height"
}

build_comparison_grid() {
  local window_id=$1
  local first_pane=$2
  local pane_count=${#pane_commands[@]}
  local row column index remaining_columns right_width pane_id bottom_index
  local current_pane first_dimensions dimensions
  local row_anchors=()

  prepare_grid_geometry "$window_id" "$pane_count"
  row_anchors[0]=$first_pane
  if ((grid_rows == 2)); then
    bottom_index=$grid_columns
    pane_id=$(tmux split-window -d -v -l "$grid_pane_height" -P -F '#{pane_id}' \
      -t "$first_pane" -c "$prototype_cwd" \
      "${pane_command_prefix[@]}" "${pane_commands[bottom_index]}")
    tmux select-pane -t "$pane_id" -T "${pane_titles[bottom_index]}"
    row_anchors[1]=$pane_id
  fi

  for ((row = 0; row < grid_rows; row++)); do
    current_pane=${row_anchors[row]}
    for ((column = 1; column < grid_columns; column++)); do
      index=$((row * grid_columns + column))
      remaining_columns=$((grid_columns - column))
      right_width=$((grid_pane_width * remaining_columns + remaining_columns - 1))
      pane_id=$(tmux split-window -d -h -l "$right_width" -P -F '#{pane_id}' \
        -t "$current_pane" -c "$prototype_cwd" \
        "${pane_command_prefix[@]}" "${pane_commands[index]}")
      tmux select-pane -t "$pane_id" -T "${pane_titles[index]}"
      current_pane=$pane_id
    done
  done

  first_dimensions=""
  while read -r dimensions; do
    if [[ -z $first_dimensions ]]; then
      first_dimensions=$dimensions
    elif [[ $dimensions != "$first_dimensions" ]]; then
      echo "tmux could not create equal prototype pane dimensions" >&2
      return 1
    fi
  done < <(tmux list-panes -t "$window_id" -F '#{pane_width}x#{pane_height}')
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
      "=$session_name" >"$attach_command"
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
        "$tmux_path" attach-session -t "=$session_name"; then
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
      tmux attach-session -t "=$session_name"; then
      return 0
    fi
  fi

  if [[ $system_name == "Linux" ]]; then
    if command -v xdg-terminal-exec >/dev/null 2>&1; then
      if xdg-terminal-exec --title="OpenClaw TUI prototypes" \
        tmux attach-session -t "=$session_name"; then
        return 0
      fi
    fi

    if [[ -n ${TERMINAL:-} ]] && command -v "$TERMINAL" >/dev/null 2>&1; then
      if "$TERMINAL" -e tmux attach-session -t "=$session_name"; then
        return 0
      fi
    fi

    if command -v x-terminal-emulator >/dev/null 2>&1; then
      if x-terminal-emulator -e tmux attach-session -t "=$session_name"; then
        return 0
      fi
    fi
  fi

  return 1
}

tmux_session_has_client() {
  local session_id=$1
  [[ -n $(tmux list-clients -t "$session_id" -F '#{client_name}' 2>/dev/null) ]]
}

wait_for_tmux_client() {
  local session_id=$1
  local attempt=0

  while ((attempt < 100)); do
    if tmux_session_has_client "$session_id"; then
      return 0
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done
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

if (( $# < 6 || $# > 14 || ($# - 2) % 2 != 0 )); then
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
if tmux has-session -t "=$session_name" 2>/dev/null; then
  session_exists=true
fi
if [[ $refresh_session == true && $session_exists == false ]]; then
  echo "tmux session does not exist: $session_name" >&2
  echo "create it first with --open" >&2
  exit 1
fi
if [[ $refresh_session == false && $session_exists == true ]]; then
  echo "tmux session already exists: $session_name" >&2
  echo "attach with: tmux attach-session -t '=$session_name'" >&2
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
placeholder_command=(/bin/sh -c 'while :; do sleep 3600; done')

if [[ $refresh_session == true ]]; then
  session_id=$(tmux display-message -p -t "=$session_name" '#{session_id}')
  previous_window_id=""
  while read -r candidate_id candidate_name; do
    if [[ $candidate_name == prototypes ]]; then
      previous_window_id=$candidate_id
      break
    fi
  done < <(tmux list-windows -t "$session_id" -F '#{window_id} #{window_name}')
  if [[ -z $previous_window_id ]]; then
    echo "tmux session has no prototypes window: $session_name" >&2
    exit 1
  fi

  refresh_window_created=false
  previous_window_renamed=false
  cleanup_failed_refresh() {
    if [[ $previous_window_renamed == true ]]; then
      tmux rename-window -t "$previous_window_id" prototypes 2>/dev/null || true
    fi
    if [[ $refresh_window_created == true ]]; then
      tmux kill-window -t "$window_id" 2>/dev/null || true
    fi
  }
  trap cleanup_failed_refresh ERR

  first_pane=$(tmux new-window -d -P -F '#{pane_id}' \
    -t "$session_id:" -n "prototypes-refresh-$$" -c "$prototype_cwd" \
    "${placeholder_command[@]}")
  refresh_window_created=true
  window_id=$(tmux display-message -p -t "$first_pane" '#{window_id}')
  configure_tmux_session "$session_id" "$window_id"

  tmux respawn-pane -k -t "$first_pane" -c "$prototype_cwd" \
    "${pane_command_prefix[@]}" "${pane_commands[0]}"
  tmux select-pane -t "$first_pane" -T "${pane_titles[0]}"
  build_comparison_grid "$window_id" "$first_pane"

  tmux rename-window -t "$previous_window_id" "prototypes-previous-$$"
  previous_window_renamed=true
  tmux rename-window -t "$window_id" prototypes
  tmux select-window -t "$window_id"
  tmux kill-window -t "$previous_window_id"
  previous_window_renamed=false
  refresh_window_created=false
  trap - ERR
else
  created_session=false
  cleanup_partial_session() {
    if [[ $created_session == true ]] && tmux has-session -t "=$session_name" 2>/dev/null; then
      tmux kill-session -t "=$session_name"
    fi
  }
  trap cleanup_partial_session ERR

  first_pane=$(tmux new-session -d -P -F '#{pane_id}' \
    -s "$session_name" -n prototypes -c "$prototype_cwd" \
    "${placeholder_command[@]}")
  created_session=true
  session_id=$(tmux display-message -p -t "$first_pane" '#{session_id}')
  window_id=$(tmux display-message -p -t "$first_pane" '#{window_id}')
  configure_tmux_session "$session_id" "$window_id"
  tmux respawn-pane -k -t "$first_pane" -c "$prototype_cwd" \
    "${pane_command_prefix[@]}" "${pane_commands[0]}"
  tmux select-pane -t "$first_pane" -T "${pane_titles[0]}"
  if [[ $open_external == true ]]; then
    if open_external_terminal "$session_name"; then
      if ! wait_for_tmux_client "$session_id"; then
        echo "external terminal opened but did not attach in time; run --refresh after attaching" >&2
      fi
    else
      echo "could not open an external terminal; attach manually with:" >&2
      printf "  tmux attach-session -t %q\n" "=$session_name" >&2
    fi
  fi
  build_comparison_grid "$window_id" "$first_pane"
fi

tmux select-pane -t "$first_pane"

trap - ERR
if [[ $refresh_session == true ]]; then
  echo "tmux session refreshed: $session_name"
else
  echo "tmux session ready: $session_name"
fi
echo "attach with: tmux attach-session -t '=$session_name'"
