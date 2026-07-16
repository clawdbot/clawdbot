// Auth monitor tests cover optional systemd and Termux helper script contracts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const AUTH_MONITOR_PATH = "scripts/auth-monitor.sh";
const MOBILE_REAUTH_PATH = "scripts/mobile-reauth.sh";
const SETUP_AUTH_SYSTEM_PATH = "scripts/setup-auth-system.sh";
const AUTH_MONITOR_SERVICE_PATH = "scripts/systemd/openclaw-auth-monitor.service";
const AUTH_MONITOR_TIMER_PATH = "scripts/systemd/openclaw-auth-monitor.timer";
const TERMUX_WIDGET_PATHS = [
  "scripts/termux-auth-widget.sh",
  "scripts/termux-quick-auth.sh",
  "scripts/termux-sync-widget.sh",
];

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

describe("auth monitoring scripts", () => {
  it("keeps systemd install rendering free of checked-in host paths", () => {
    const setup = readScript(SETUP_AUTH_SYSTEM_PATH);
    const service = readScript(AUTH_MONITOR_SERVICE_PATH);
    const timer = readScript(AUTH_MONITOR_TIMER_PATH);

    expect(service).toContain("ExecStart=@OPENCLAW_AUTH_MONITOR_PATH@");
    expect(setup).toContain('AUTH_MONITOR_PATH="$SCRIPT_DIR/auth-monitor.sh"');
    expect(setup).toContain(
      'RENDERED_EXEC_START="ExecStart=$(systemd_quote_arg "$AUTH_MONITOR_PATH")"',
    );
    expect(timer).toContain("OnUnitActiveSec=30min");
  });

  it("keeps public helper scripts free of private host defaults", () => {
    const privateHomePath = ["", "home", "admin"].join("/");
    const privateHostAlias = ["l", "36"].join("");
    const scripts = [AUTH_MONITOR_PATH, AUTH_MONITOR_SERVICE_PATH, ...TERMUX_WIDGET_PATHS].map(
      readScript,
    );
    const joined = scripts.join("\n");

    expect(joined).not.toContain(privateHomePath);
    expect(joined).not.toContain(privateHostAlias);
    expect(joined).toContain("Run on the OpenClaw host: ${SCRIPT_DIR}/mobile-reauth.sh");
    for (const script of TERMUX_WIDGET_PATHS.map(readScript)) {
      expect(script).toContain('SERVER="${OPENCLAW_SERVER:-openclaw-host}"');
    }
    expect(readScript("scripts/termux-sync-widget.sh")).toContain(
      "'$HOME/openclaw/scripts/sync-claude-code-auth.sh'",
    );
  });

  it("bounds ntfy notification requests", () => {
    const script = readScript(AUTH_MONITOR_PATH);

    expect(script).toContain("curl -s --connect-timeout 5 --max-time 15 -o /dev/null");
  });

  it("keeps mobile reauth wired to local auth status and Claude token setup", () => {
    const script = readScript(MOBILE_REAUTH_PATH);

    expect(script).toContain('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
    expect(script).toContain('"$SCRIPT_DIR/claude-auth-status.sh" simple');
    expect(script).toContain('"$SCRIPT_DIR/claude-auth-status.sh" full');
    expect(script).toContain("https://console.anthropic.com/settings/api-keys");
    expect(script).toContain("claude setup-token");
    expect(script).toContain("systemctl --user restart openclaw");
  });
});
