// Doctor format tests cover doctor output formatting and issue display helpers.
import { describe, expect, it } from "vitest";
import { buildGatewayRuntimeHints } from "./doctor-format.js";

describe("buildGatewayRuntimeHints", () => {
  it("prioritizes macOS GUI-session failures over generic missing supervision", () => {
    const hints = buildGatewayRuntimeHints(
      {
        status: "unknown",
        missingSupervision: true,
        missingGuiSession: true,
      },
      { platform: "darwin", env: {} },
    );

    expect(hints.join("\n")).toContain("logged-in macOS GUI session");
    expect(hints.join("\n")).not.toContain("LaunchAgent installed but not loaded");
  });

  it("surfaces suspicious systemd cgroup hygiene with inspection commands", () => {
    expect(
      buildGatewayRuntimeHints(
        {
          status: "running",
          pid: 1234,
          systemd: {
            unit: "openclaw-gateway.service",
            killMode: "process",
            tasksCurrent: 807,
            memoryCurrent: 11_918_534_246,
          },
        },
        { platform: "linux", env: {} },
      ),
    ).toEqual([
      "Systemd cgroup hygiene looks elevated: cgroup hygiene: KillMode=process, tasks=807, memory=11.1GiB.",
      "This usually means old helper or browser processes may still be attached to the gateway service.",
      "Run: systemctl --user show openclaw-gateway.service -p KillMode -p TasksCurrent -p MemoryCurrent -p MainPID",
      "Run: systemd-cgls --user-unit openclaw-gateway.service",
      "After reviewing service settings, run: openclaw gateway restart",
    ]);
  });

  it("uses the provided env when rendering WSL systemd recovery hints", () => {
    const hints = buildGatewayRuntimeHints(
      {
        status: "unknown",
        detail: "System has not been booted with systemd as init system",
      },
      { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } },
    );

    expect(hints).toContain(
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
    );
    expect(hints).toContain("Then run: wsl --shutdown (from PowerShell) and reopen your distro.");
    expect(hints).toContain("Verify: systemctl --user status");
    expect(hints.join("\n")).not.toContain("systemd user services are unavailable");
  });

  it("guides recovery when systemd hit its restart start limit (crash loop)", () => {
    // Real give-up shape: process kept failing (Result=exit-code) until NRestarts
    // reached StartLimitBurst and systemd stopped restarting.
    const text = buildGatewayRuntimeHints(
      {
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      },
      { platform: "linux", env: {} },
    ).join("\n");

    expect(text).toContain("systemd stopped restarting the gateway after repeated crashes");
    expect(text).toContain("openclaw gateway restart");
    expect(text).not.toContain("likely exited immediately");
  });

  it("keeps the generic stopped hint for a single failed exit below the start limit", () => {
    const text = buildGatewayRuntimeHints(
      {
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 1, startLimitBurst: 5 },
      },
      { platform: "linux", env: {} },
    ).join("\n");

    expect(text).toContain("likely exited immediately");
    expect(text).not.toContain("systemd stopped restarting the gateway");
  });

  it("keeps the generic stopped hint after a config exit (78) despite a stale restart count", () => {
    // RestartPreventExitStatus=78 stopped systemd on purpose; the leftover
    // NRestarts must not flip the hint to start-limit recovery guidance.
    const text = buildGatewayRuntimeHints(
      {
        status: "stopped",
        state: "failed",
        lastExitStatus: 78,
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      },
      { platform: "linux", env: {} },
    ).join("\n");

    expect(text).toContain("likely exited immediately");
    expect(text).not.toContain("systemd stopped restarting the gateway");
  });

  it("keeps the generic stopped hint for an ordinary cleanly-stopped service", () => {
    const text = buildGatewayRuntimeHints(
      { status: "stopped", state: "inactive" },
      { platform: "linux", env: {} },
    ).join("\n");

    expect(text).toContain("likely exited immediately");
    expect(text).not.toContain("systemd stopped restarting the gateway");
  });

  it("does not warn for normal systemd cgroup metrics", () => {
    expect(
      buildGatewayRuntimeHints(
        {
          status: "running",
          pid: 1234,
          systemd: {
            unit: "openclaw-gateway.service",
            killMode: "control-group",
            tasksCurrent: 7,
            memoryCurrent: 132_120_576,
          },
        },
        { platform: "linux", env: {} },
      ),
    ).toEqual([]);
  });
});
