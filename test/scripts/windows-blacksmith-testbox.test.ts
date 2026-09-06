import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const workflow = parse(
  fs.readFileSync(".github/workflows/windows-blacksmith-testbox.yml", "utf8"),
) as {
  jobs: { windows: { steps: { name: string; run?: string }[] } };
};
const run = workflow.jobs.windows.steps.find((step) => step.name === "Run Testbox")?.run;
if (!run) {
  throw new Error("Missing Windows Testbox run step");
}
// Execute the actual monitor after its ready banner, without contacting Blacksmith.
const banner = 'echo "============================================"';
const monitor = run.slice(run.lastIndexOf(banner) + banner.length);

function runMonitor(options: {
  rows?: string;
  ports?: string;
  activeUntil?: number;
  marker?: { observedAt: number; modifiedAt: number };
  discoveryExit?: number;
  netstatExit?: number;
}) {
  const dir = createTempDir("openclaw-windows-idle-");
  fs.writeFileSync(path.join(dir, "connections"), options.rows ?? "");
  const markerSeed = path.join(dir, "marker-seed");
  fs.writeFileSync(markerSeed, "");
  const markerTime = options.marker?.modifiedAt ?? 1000;
  fs.utimesSync(markerSeed, markerTime, markerTime);
  return spawnSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      `
clock=1000
runner_ssh_port=64004
idle_timeout=1
trap 'printf "monitor_clock=%s\\n" "$clock"' EXIT
date() { printf '%s\\n' "$clock"; }
sleep() {
  clock=$((clock + 30))
  if [ "$clock" = "$MARKER_AT" ]; then cp -p "$HOME/marker-seed" "$HOME/.testbox-last-activity"; fi
  if [ "$clock" -gt 1300 ]; then return 90; fi
}
pwsh() { printf '%s' "$LOCAL_PORTS"; return "$DISCOVERY_EXIT"; }
netstat() {
  if [ "$clock" -le "$ACTIVE_UNTIL" ]; then command cat "$HOME/connections"; fi
  return "$NETSTAT_EXIT"
}
${monitor}`,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        HOME: dir,
        LOCAL_PORTS: options.ports ?? "22",
        ACTIVE_UNTIL: String(options.activeUntil ?? 1090),
        MARKER_AT: String(options.marker?.observedAt ?? 0),
        DISCOVERY_EXIT: String(options.discoveryExit ?? 0),
        NETSTAT_EXIT: String(options.netstatExit ?? 0),
      },
    },
  );
}

describe.skipIf(process.platform === "win32")("native Windows Testbox idle monitor", () => {
  it.each([
    { name: "IPv4", ports: "22", local: "172.16.0.2:22" },
    { name: "IPv6", ports: "22", local: "[2001:db8::1]:22" },
    { name: "a second non-default listener", ports: "2201|2202", local: "172.16.0.2:2202" },
  ])("keeps $name SSH active, then expires after disconnect", ({ ports, local }) => {
    const result = runMonitor({
      ports,
      rows: `  TCP    ${local}    192.0.2.1:51000    ESTABLISHED\r\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("monitor_clock=1150");
    expect(result.stdout).toContain("Idle timeout reached (1 minutes). Shutting down.");
  });

  it("does not count listeners, foreign ports, port prefixes, or closed connections as activity", () => {
    const result = runMonitor({
      rows: [
        "  TCP    0.0.0.0:22       0.0.0.0:0           LISTENING",
        "  TCP    172.16.0.2:2222  192.0.2.1:51000     ESTABLISHED",
        "  TCP    172.16.0.2:51000 192.0.2.1:64004     ESTABLISHED",
        "  TCP    172.16.0.2:51001 192.0.2.1:22        ESTABLISHED",
        "  TCP    [2001:db8::1]:22 [2001:db8::2]:51000 TIME_WAIT",
        "",
      ].join("\r\n"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("monitor_clock=1060");
  });

  it.each([
    { name: "a command between polls", modifiedAt: 1015, expectedClock: 1090 },
    { name: "an old command", modifiedAt: 970, expectedClock: 1060 },
  ])(
    "uses the marker mtime for $name without keeping the lease alive forever",
    ({ modifiedAt, expectedClock }) => {
      const result = runMonitor({ marker: { observedAt: 1030, modifiedAt } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`monitor_clock=${expectedClock}`);
    },
  );

  it.each([
    { name: "listener discovery", discoveryExit: 7, expectedExit: 7 },
    { name: "connection enumeration", netstatExit: 9, expectedExit: 9 },
  ])(
    "reports $name failures instead of classifying them as idle",
    ({ expectedExit, ...options }) => {
      const result = runMonitor(options);
      expect(result.status, result.stderr).toBe(expectedExit);
      expect(result.stdout).not.toContain("Idle timeout reached");
    },
  );
});
