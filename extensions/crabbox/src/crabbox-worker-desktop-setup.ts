import path from "node:path";
import { WorkerProviderError, type WorkerDesktopEndpoint } from "openclaw/plugin-sdk/plugin-entry";

const CRABBOX_WORKER_BROWSER_PATH = "/usr/local/bin/openclaw-worker-browser";
const CRABBOX_WORKER_TERMINAL_PATH = "/usr/local/bin/openclaw-worker-terminal";
const CRABBOX_WORKER_BROWSER_CDP_PORT = 9222;

const SSH_USER_PATTERN = /^(?:root|[a-z_][a-z0-9_-]{0,31})$/u;

function resolveCrabboxWorkerHome(sshUser: string): string {
  if (!SSH_USER_PATTERN.test(sshUser)) {
    throw new WorkerProviderError("Crabbox inspect returned an invalid desktop SSH user");
  }
  const home = sshUser === "root" ? "/root" : `/home/${sshUser}`;
  if (!path.posix.isAbsolute(home) || path.posix.normalize(home) !== home) {
    throw new WorkerProviderError("Crabbox inspect returned an invalid desktop home path");
  }
  return home;
}

function browserLauncher(home: string, browserProfilePath: string): string[] {
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    '[ "$#" -eq 0 ] || { echo "openclaw-worker-browser does not accept arguments" >&2; exit 64; }',
    '[ -r /var/lib/crabbox/desktop.env ] || { echo "Crabbox desktop environment is unavailable" >&2; exit 1; }',
    '[ -r /var/lib/crabbox/browser.env ] || { echo "Crabbox browser environment is unavailable" >&2; exit 1; }',
    ". /var/lib/crabbox/desktop.env",
    ". /var/lib/crabbox/browser.env",
    '[ "${CRABBOX_DESKTOP_ENV:-}" = "xfce" ] || { echo "Crabbox desktop environment is not XFCE" >&2; exit 1; }',
    '[ "${DISPLAY:-}" = ":99" ] || { echo "Crabbox XFCE display is not :99" >&2; exit 1; }',
    `export HOME=${home}`,
    "export DISPLAY",
    `export CRABBOX_BROWSER_PROFILE=${browserProfilePath}`,
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
    '[ -r /var/lib/crabbox/desktop.env ] || { echo "Crabbox desktop environment is unavailable" >&2; exit 1; }',
    ". /var/lib/crabbox/desktop.env",
    '[ "${CRABBOX_DESKTOP_ENV:-}" = "xfce" ] || { echo "Crabbox desktop environment is not XFCE" >&2; exit 1; }',
    '[ "${DISPLAY:-}" = ":99" ] || { echo "Crabbox XFCE display is not :99" >&2; exit 1; }',
    "export DISPLAY",
    "nohup /usr/bin/xfce4-terminal >/dev/null 2>&1 </dev/null &",
    "terminal_pid=$!",
    "sleep 0.2",
    'if kill -0 "$terminal_pid" 2>/dev/null; then',
    "  exit 0",
    "fi",
    'wait "$terminal_pid"',
  ];
}

function workerWallpaper(): string[] {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">',
    "  <defs>",
    '    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">',
    '      <path d="M48 0H0V48" fill="none" stroke="#7f8a83" stroke-opacity="0.055" stroke-width="1"/>',
    "    </pattern>",
    "  </defs>",
    '  <rect width="1920" height="1080" fill="#111512"/>',
    '  <rect width="1920" height="1080" fill="url(#grid)"/>',
    '  <g transform="translate(780 360) scale(3)" fill="#d5d9d6" fill-opacity="0.13" stroke="#eef0ef" stroke-opacity="0.16">',
    '    <path d="M60 10C30 10 15 35 15 55s15 40 30 45v10h10v-10c0 0 5 2 10 0v10h10v-10c15-5 30-25 30-45S90 10 60 10Z"/>',
    '    <path d="M20 45C5 40 0 50 5 60s15 5 20-5c3-7 0-10-5-10Z"/>',
    '    <path d="M100 45c15-5 20 5 15 15s-15 5-20-5c-3-7 0-10 5-10Z"/>',
    '    <path d="M45 15Q35 5 30 8M75 15Q85 5 90 8" fill="none" stroke-linecap="round" stroke-width="3"/>',
    '    <circle cx="45" cy="35" r="6" fill="#111512" stroke="none"/>',
    '    <circle cx="75" cy="35" r="6" fill="#111512" stroke="none"/>',
    "  </g>",
    '  <text x="960" y="790" text-anchor="middle" fill="#cbd0cc" fill-opacity="0.42" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" letter-spacing="8">OPENCLAW WORKER</text>',
    "</svg>",
  ];
}

function heredoc(target: string, marker: string, contents: string[]): string[] {
  return [`cat >"$setup_dir/${target}" <<'${marker}'`, ...contents, marker];
}

function buildCrabboxWorkerDesktopSetup(sshUser: string): string {
  const home = resolveCrabboxWorkerHome(sshUser);
  const browserProfilePath = `${home}/.cache/openclaw/worker-browser`;
  const wallpaperPath = `${home}/.local/share/backgrounds/openclaw-worker.svg`;
  const lines = [
    "set -euo pipefail",
    `ssh_user=${sshUser}`,
    `ssh_home=${home}`,
    '[ "$(id -un)" = "$ssh_user" ] || { echo "Crabbox setup did not run as the advertised SSH user" >&2; exit 1; }',
    'passwd_home=$(getent passwd "$ssh_user" | cut -d: -f6)',
    '[ "$passwd_home" = "$ssh_home" ] || { echo "Crabbox SSH user home does not match the worker desktop contract" >&2; exit 1; }',
    'ssh_group=$(id -gn "$ssh_user")',
    'as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n -- "$@"; fi; }',
    '[ -r /var/lib/crabbox/desktop.env ] || { echo "Crabbox desktop environment is unavailable" >&2; exit 1; }',
    ". /var/lib/crabbox/desktop.env",
    '[ "${CRABBOX_DESKTOP_ENV:-}" = "xfce" ] || { echo "Crabbox desktop environment is not XFCE" >&2; exit 1; }',
    '[ "${DISPLAY:-}" = ":99" ] || { echo "Crabbox XFCE display is not :99" >&2; exit 1; }',
    "export DISPLAY",
    'for required_command in xfconf-query curl flock; do command -v "$required_command" >/dev/null 2>&1 || { echo "Required Crabbox desktop command is unavailable: $required_command" >&2; exit 1; }; done',
    "setup_dir=$(mktemp -d)",
    "trap 'rm -rf -- \"$setup_dir\"' EXIT",
    ...heredoc("browser", "WORKER_BROWSER_LAUNCHER_EOF", browserLauncher(home, browserProfilePath)),
    ...heredoc("terminal", "WORKER_TERMINAL_LAUNCHER_EOF", terminalLauncher()),
    ...heredoc("wallpaper.svg", "WORKER_WALLPAPER_EOF", workerWallpaper()),
    `as_root install -o root -g root -m 0755 "$setup_dir/browser" ${CRABBOX_WORKER_BROWSER_PATH}`,
    `as_root install -o root -g root -m 0755 "$setup_dir/terminal" ${CRABBOX_WORKER_TERMINAL_PATH}`,
    'as_root install -d -o "$ssh_user" -g "$ssh_group" -m 0755 "$ssh_home/.cache" "$ssh_home/.cache/openclaw"',
    `as_root install -d -o "$ssh_user" -g "$ssh_group" -m 0700 ${browserProfilePath}`,
    'as_root install -d -o "$ssh_user" -g "$ssh_group" -m 0755 "$ssh_home/.local" "$ssh_home/.local/share" "$ssh_home/.local/share/backgrounds"',
    `as_root install -o "$ssh_user" -g "$ssh_group" -m 0644 "$setup_dir/wallpaper.svg" ${wallpaperPath}`,
    "mapfile -t backdrop_roots < <(xfconf-query -c xfce4-desktop -l | sed -n 's#\\(/backdrop/[^/]*/[^/]*/workspace[^/]*\\)/.*#\\1#p' | sort -u)",
    '[ "${#backdrop_roots[@]}" -gt 0 ] || { echo "XFCE did not advertise any desktop backdrops" >&2; exit 1; }',
    'for backdrop in "${backdrop_roots[@]}"; do',
    `  xfconf-query -c xfce4-desktop -p "$backdrop/last-image" -s ${wallpaperPath} || xfconf-query -c xfce4-desktop -p "$backdrop/last-image" -n -t string -s ${wallpaperPath}`,
    '  xfconf-query -c xfce4-desktop -p "$backdrop/image-style" -s 5 || xfconf-query -c xfce4-desktop -p "$backdrop/image-style" -n -t int -s 5',
    "done",
  ];
  return lines.join("\n");
}

export function createCrabboxWorkerDesktopEndpoint(sshUser: string): WorkerDesktopEndpoint {
  resolveCrabboxWorkerHome(sshUser);
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

export async function provisionCrabboxWorkerDesktop<T>(
  enabled: boolean,
  sshUser: string,
  current: T,
  stopInvalid: () => Promise<void>,
  run: (setup: string) => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return current;
  }
  let setup: string;
  try {
    setup = buildCrabboxWorkerDesktopSetup(sshUser);
  } catch (error) {
    if (error instanceof WorkerProviderError) {
      await stopInvalid();
    }
    throw error;
  }
  return await run(setup);
}
