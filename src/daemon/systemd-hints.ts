/** Renders Linux systemd availability hints for gateway service commands. */
import { formatCliCommand } from "../cli/command-format.js";
import { isWSL } from "../infra/wsl.js";
import { resolveDaemonContainerContext } from "./container-context.js";
import {
  classifySystemdUnavailableDetail,
  type SystemdUnavailableKind,
} from "./systemd-unavailable.js";

type SystemdUnavailableHintOptions = {
  wsl?: boolean;
  kind?: SystemdUnavailableKind | null;
  env?: Record<string, string | undefined>;
};

/** Detects details that should get systemd availability repair hints. */
export function isSystemdUnavailableDetail(detail?: string): boolean {
  return classifySystemdUnavailableDetail(detail) !== null;
}

function renderSystemdHeadlessServerHints(): string[] {
  return [
    "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
    "Also ensure XDG_RUNTIME_DIR is set: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then retry.",
    "If `/run/user/$(id -u)/bus` is missing, install the D-Bus user session bus (Debian/Ubuntu: `sudo apt-get install dbus-user-session`), then run `systemctl --user daemon-reload && systemctl --user start dbus.socket`.",
  ];
}

export function renderSystemdUnavailableHints(
  options: SystemdUnavailableHintOptions = {},
): string[] {
  if (options.wsl) {
    // WSL requires systemd opt-in at distro boot, not just a package install.
    return [
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ];
  }
  return [
    "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
    ...(resolveDaemonContainerContext(options.env) || options.kind !== "user_bus_unavailable"
      ? []
      : renderSystemdHeadlessServerHints()),
    `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway", options.env)}\`.`,
  ];
}

/** Hints for a failed Linux service-manager call; undefined when the failure is not a known systemd family. */
export async function renderSystemdErrorHints(error: unknown): Promise<string[] | undefined> {
  const kind =
    process.platform === "linux" ? classifySystemdUnavailableDetail(String(error)) : null;
  return kind ? renderSystemdUnavailableHints({ wsl: await isWSL(), kind }) : undefined;
}
