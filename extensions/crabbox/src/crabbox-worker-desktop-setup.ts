import type { WorkerDesktopEndpoint } from "openclaw/plugin-sdk/plugin-entry";

const CRABBOX_WORKER_BROWSER_PATH = "/usr/local/bin/openclaw-worker-browser";
const CRABBOX_WORKER_TERMINAL_PATH = "/usr/local/bin/openclaw-worker-terminal";
const CRABBOX_WORKER_BROWSER_CDP_PORT = 9222;

function xfceDesktopEnvironment(): string[] {
  return [
    '[ -r /var/lib/crabbox/desktop.env ] || { echo "Crabbox desktop environment is unavailable" >&2; exit 1; }',
    "grep -Fx 'CRABBOX_DESKTOP_ENV=xfce' /var/lib/crabbox/desktop.env >/dev/null || { echo \"Crabbox desktop environment is not XFCE\" >&2; exit 1; }",
    "grep -Fx 'DISPLAY=:99' /var/lib/crabbox/desktop.env >/dev/null || { echo \"Crabbox XFCE display is not :99\" >&2; exit 1; }",
    "export DISPLAY=:99",
  ];
}

function browserLauncher(leaseId: string): string[] {
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    '[ "$#" -eq 0 ] || { echo "openclaw-worker-browser does not accept arguments" >&2; exit 64; }',
    ...xfceDesktopEnvironment(),
    '[ -x /usr/local/bin/crabbox-browser ] || { echo "Crabbox browser is unavailable" >&2; exit 1; }',
    'worker_home=$(getent passwd "$(id -u)" | cut -d: -f6)',
    'case "$worker_home" in /*) ;; *) echo "Crabbox worker home is invalid" >&2; exit 1 ;; esac',
    'export HOME="$worker_home"',
    `export CRABBOX_BROWSER_PROFILE="$worker_home/.cache/openclaw/worker-browser/${leaseId}"`,
    'mkdir -p "$CRABBOX_BROWSER_PROFILE"',
    'chmod 700 "$CRABBOX_BROWSER_PROFILE"',
    'exec 9>"$CRABBOX_BROWSER_PROFILE/.openclaw-launch.lock"',
    "flock -x 9",
    `cdp_url=http://127.0.0.1:${CRABBOX_WORKER_BROWSER_CDP_PORT}/json/version`,
    'if curl --fail --silent --show-error --max-time 1 "$cdp_url" >/dev/null; then',
    "  exit 0",
    "fi",
    'launch_log="$CRABBOX_BROWSER_PROFILE/launch.log"',
    ': >"$launch_log"',
    `nohup /usr/local/bin/crabbox-browser --remote-debugging-address=127.0.0.1 --remote-debugging-port=${CRABBOX_WORKER_BROWSER_CDP_PORT} about:blank >>"$launch_log" 2>&1 </dev/null &`,
    "for _attempt in $(seq 1 40); do",
    '  if curl --fail --silent --show-error --max-time 1 "$cdp_url" >/dev/null; then',
    "    exit 0",
    "  fi",
    "  sleep 0.5",
    "done",
    `echo "Browser CDP did not become ready on 127.0.0.1:${CRABBOX_WORKER_BROWSER_CDP_PORT} within 20 seconds" >&2`,
    "exit 1",
  ];
}

function terminalLauncher(): string[] {
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    '[ "$#" -eq 0 ] || { echo "openclaw-worker-terminal does not accept arguments" >&2; exit 64; }',
    ...xfceDesktopEnvironment(),
    "nohup /usr/bin/xfce4-terminal >/dev/null 2>&1 </dev/null &",
    "terminal_pid=$!",
    "sleep 0.2",
    'if kill -0 "$terminal_pid" 2>/dev/null; then',
    "  exit 0",
    "fi",
    'wait "$terminal_pid"',
  ];
}

function heredoc(target: string, marker: string, contents: string[]): string[] {
  return [`cat >"$setup_dir/${target}" <<'${marker}'`, ...contents, marker];
}

export function createCrabboxWorkerDesktopSetup(leaseId: string, wallpaperBase64: string): string {
  return [
    "set -euo pipefail",
    "worker_user=$(id -un)",
    "worker_uid=$(id -u)",
    "worker_group=$(id -gn)",
    'worker_home=$(getent passwd "$worker_uid" | cut -d: -f6)',
    'case "$worker_home" in /*) ;; *) echo "Crabbox worker home is invalid" >&2; exit 1 ;; esac',
    'as_root() { if [ "$worker_uid" -eq 0 ]; then "$@"; else sudo -n -- "$@"; fi; }',
    ...xfceDesktopEnvironment(),
    'for required_command in xfconf-query xfdesktop xrandr awk curl flock getent pgrep pkill python3; do command -v "$required_command" >/dev/null 2>&1 || { echo "Required Crabbox desktop command is unavailable: $required_command" >&2; exit 1; }; done',
    "setup_dir=$(mktemp -d)",
    "trap 'rm -rf -- \"$setup_dir\"' EXIT",
    ...heredoc("browser", "WORKER_BROWSER_LAUNCHER_EOF", browserLauncher(leaseId)),
    ...heredoc("terminal", "WORKER_TERMINAL_LAUNCHER_EOF", terminalLauncher()),
    `python3 -c 'import base64,pathlib,sys;pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(sys.stdin.buffer.read().strip(),validate=True))' "$setup_dir/wallpaper.png" <<'WORKER_WALLPAPER_B64_EOF'`,
    wallpaperBase64,
    "WORKER_WALLPAPER_B64_EOF",
    `as_root install -o root -g root -m 0755 "$setup_dir/browser" ${CRABBOX_WORKER_BROWSER_PATH}`,
    `as_root install -o root -g root -m 0755 "$setup_dir/terminal" ${CRABBOX_WORKER_TERMINAL_PATH}`,
    'as_root install -d -o "$worker_user" -g "$worker_group" -m 0755 "$worker_home/.cache" "$worker_home/.cache/openclaw" "$worker_home/.cache/openclaw/worker-browser"',
    `as_root install -d -o "$worker_user" -g "$worker_group" -m 0700 "$worker_home/.cache/openclaw/worker-browser/${leaseId}"`,
    'as_root install -d -o "$worker_user" -g "$worker_group" -m 0755 "$worker_home/.local" "$worker_home/.local/share" "$worker_home/.local/share/backgrounds"',
    'wallpaper_path="$worker_home/.local/share/backgrounds/openclaw-worker.png"',
    'as_root install -o "$worker_user" -g "$worker_group" -m 0644 "$setup_dir/wallpaper.png" "$wallpaper_path"',
    "mapfile -t backdrop_roots < <(",
    "  {",
    "    xfconf-query -c xfce4-desktop -l | sed -n 's#\\(/backdrop/[^/]*/[^/]*/workspace[^/]*\\)/.*#\\1#p'",
    '    while read -r monitor; do for workspace in 0 1 2 3; do printf "/backdrop/screen0/monitor%s/workspace%s\\n" "$monitor" "$workspace"; done; done < <(xrandr --listmonitors | awk \'NR > 1 { print $NF }\')',
    "  } | sort -u",
    ")",
    '[ "${#backdrop_roots[@]}" -gt 0 ] || { echo "XFCE did not advertise any desktop backdrops" >&2; exit 1; }',
    'for backdrop in "${backdrop_roots[@]}"; do',
    '  xfconf-query -c xfce4-desktop -p "$backdrop/last-image" -s "$wallpaper_path" || xfconf-query -c xfce4-desktop -p "$backdrop/last-image" -n -t string -s "$wallpaper_path"',
    '  xfconf-query -c xfce4-desktop -p "$backdrop/image-style" -s 5 || xfconf-query -c xfce4-desktop -p "$backdrop/image-style" -n -t int -s 5',
    "done",
    "# Setup precedes enrollment and publication, so replacing the renderer cannot drop an observer.",
    "pkill -TERM -x xfdesktop || true",
    "for _attempt in $(seq 1 20); do pgrep -x xfdesktop >/dev/null || break; sleep 0.1; done",
    "pkill -KILL -x xfdesktop || true",
    'nohup xfdesktop >"$worker_home/.cache/openclaw/xfdesktop.log" 2>&1 </dev/null &',
    "for _attempt in $(seq 1 20); do pgrep -x xfdesktop >/dev/null && break; sleep 0.1; done",
    'pgrep -x xfdesktop >/dev/null || { echo "XFCE desktop renderer did not restart" >&2; exit 1; }',
  ].join("\n");
}

export function createCrabboxWorkerDesktopEndpoint(): WorkerDesktopEndpoint {
  return {
    protocol: "rfb",
    port: 5900,
    passwordFilePath: "/var/lib/crabbox/vnc.password",
    apps: [
      {
        id: "browser",
        executablePath: CRABBOX_WORKER_BROWSER_PATH,
        cdpPort: CRABBOX_WORKER_BROWSER_CDP_PORT,
      },
      { id: "terminal", executablePath: CRABBOX_WORKER_TERMINAL_PATH },
    ],
  };
}
