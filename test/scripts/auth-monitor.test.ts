// Auth monitor tests cover optional systemd and Termux helper script contracts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function createAuthMonitorHarness() {
  const home = mkdtempSync(join(tmpdir(), "openclaw-auth-monitor-"));
  const binDir = join(home, "bin");
  const curlLog = join(home, "curl.log");
  const openclawLog = join(home, "openclaw.log");
  const stateFile = join(home, ".openclaw", "auth-monitor-state");
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "curl"),
    '#!/bin/sh\nprintf "called\\n" >> "$FAKE_CURL_LOG"\nexit "$FAKE_CURL_EXIT_CODE"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "openclaw"),
    [
      "#!/bin/sh",
      'if [ "$1" = "models" ]; then',
      "  exit 1",
      "fi",
      'printf "called\\n" >> "$FAKE_OPENCLAW_LOG"',
      'exit "$FAKE_OPENCLAW_EXIT_CODE"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    curlLog,
    home,
    openclawLog,
    stateFile,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
    enablePhoneAuth: () => {
      const expiresAt = Date.now() + 90 * 60 * 1000;
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".openclaw", "agents", "main", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { expiresAt } }),
      );
      writeFileSync(
        join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
        JSON.stringify({
          profiles: { "anthropic:default": { expires: expiresAt, provider: "anthropic" } },
        }),
      );
    },
    run: ({
      curlExitCode = 0,
      notifyNtfy = "test-topic",
      notifyPhone = "",
      openclawExitCode = 0,
    }: {
      curlExitCode?: number;
      notifyNtfy?: string;
      notifyPhone?: string;
      openclawExitCode?: number;
    } = {}) =>
      spawnSync("bash", [AUTH_MONITOR_PATH], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CURL_EXIT_CODE: String(curlExitCode),
          FAKE_CURL_LOG: curlLog,
          FAKE_OPENCLAW_EXIT_CODE: String(openclawExitCode),
          FAKE_OPENCLAW_LOG: openclawLog,
          HOME: home,
          NOTIFY_NTFY: notifyNtfy,
          NOTIFY_PHONE: notifyPhone,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          WARN_HOURS: "2",
        },
      }),
  };
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

    expect(script).toContain("curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null");
  });

  it("retries after ntfy rejects a notification", () => {
    const harness = createAuthMonitorHarness();

    try {
      const rejected = harness.run({ curlExitCode: 22 });
      expect(rejected.status).toBe(1);
      expect(existsSync(harness.stateFile)).toBe(false);
      expect(rejected.stderr).toContain("No notification delivered; cooldown not updated");

      const retry = harness.run();
      expect(retry.stdout).toContain("Sending via ntfy.sh to test-topic...");
      expect(retry.stdout).not.toContain("Skipping notification (sent recently)");
      expect(readFileSync(harness.curlLog, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      harness.cleanup();
    }
  });

  it("rate-limits after ntfy accepts a notification", () => {
    const harness = createAuthMonitorHarness();

    try {
      const accepted = harness.run();
      expect(accepted.status).toBe(1);
      expect(existsSync(harness.stateFile)).toBe(true);

      const throttled = harness.run();
      expect(throttled.stdout).toContain("Skipping notification (sent recently)");
      expect(readFileSync(harness.curlLog, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      harness.cleanup();
    }
  });

  it("rate-limits after any configured notification channel succeeds", () => {
    const harness = createAuthMonitorHarness();
    harness.enablePhoneAuth();

    try {
      const delivered = harness.run({
        curlExitCode: 22,
        notifyPhone: "+15550000000",
      });
      expect(delivered.status).toBe(0);
      expect(existsSync(harness.stateFile)).toBe(true);

      const throttled = harness.run({
        curlExitCode: 22,
        notifyPhone: "+15550000000",
      });
      expect(throttled.stdout).toContain("Skipping notification (sent recently)");
      expect(readFileSync(harness.openclawLog, "utf8").trim().split("\n")).toHaveLength(1);
      expect(readFileSync(harness.curlLog, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      harness.cleanup();
    }
  });

  it("retries when all configured notification channels fail", () => {
    const harness = createAuthMonitorHarness();
    harness.enablePhoneAuth();

    try {
      const failed = harness.run({
        curlExitCode: 22,
        notifyPhone: "+15550000000",
        openclawExitCode: 1,
      });
      expect(failed.status).toBe(0);
      expect(existsSync(harness.stateFile)).toBe(false);
      expect(failed.stderr).toContain("No notification delivered; cooldown not updated");

      const retry = harness.run({
        curlExitCode: 22,
        notifyPhone: "+15550000000",
        openclawExitCode: 1,
      });
      expect(retry.stdout).not.toContain("Skipping notification (sent recently)");
      expect(readFileSync(harness.openclawLog, "utf8").trim().split("\n")).toHaveLength(2);
      expect(readFileSync(harness.curlLog, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      harness.cleanup();
    }
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
