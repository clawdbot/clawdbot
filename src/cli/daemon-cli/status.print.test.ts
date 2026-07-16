// Daemon status print tests cover user-facing service status formatting.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../command-format.js";
import { printDaemonStatus } from "./status.print.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
}));
const resolveControlUiLinksMock = vi.hoisted(() =>
  vi.fn((_opts?: unknown) => ({ httpUrl: "http://127.0.0.1:18789" })),
);
const isSystemdUnavailableDetailMock = vi.hoisted(() => vi.fn(() => false));
const renderSystemdUnavailableHintsMock = vi.hoisted(() => vi.fn<() => string[]>(() => []));
const isWSLEnvMock = vi.hoisted(() =>
  vi.fn((env?: Record<string, string | undefined>) => Boolean(env?.WSL_DISTRO_NAME)),
);

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../../../packages/terminal-core/src/theme.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/terminal-core/src/theme.js")
  >("../../../packages/terminal-core/src/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

vi.mock("../../gateway/control-ui-links.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
}));

vi.mock("../../daemon/inspect.js", () => ({
  renderGatewayServiceCleanupHints: () => [],
}));

vi.mock("../../daemon/restart-logs.js", () => ({
  resolveGatewayLogPaths: () => ({
    logDir: "/tmp",
    stdoutPath: "/tmp/gateway.out.log",
    stderrPath: "/tmp/gateway.err.log",
  }),
  resolveGatewaySupervisorLogPaths: () => ({
    logDir: "/Users/test/Library/Logs/openclaw",
    stdoutPath: "/Users/test/Library/Logs/openclaw/gateway.log",
    stderrPath: "/Users/test/Library/Logs/openclaw/gateway.err.log",
  }),
  resolveGatewayRestartLogPath: () => "/tmp/gateway-restart.log",
}));

vi.mock("../../daemon/systemd-hints.js", () => ({
  isSystemdUnavailableDetail: isSystemdUnavailableDetailMock,
  renderSystemdUnavailableHints: renderSystemdUnavailableHintsMock,
}));

vi.mock("../../infra/wsl.js", () => ({
  isWSLEnv: isWSLEnvMock,
}));

vi.mock("./shared.js", () => ({
  createCliStatusTextStyles: () => ({
    rich: false,
    label: (text: string) => text,
    accent: (text: string) => text,
    infoText: (text: string) => text,
    okText: (text: string) => text,
    warnText: (text: string) => text,
    errorText: (text: string) => text,
  }),
  filterDaemonEnv: () => ({}),
  formatRuntimeStatus: () => "running (pid 8000)",
  resolveRuntimeStatusColor: () => "",
  resolveDaemonContainerContext: () => null,
  renderRuntimeHints: () => [],
  safeDaemonEnv: () => [],
}));

vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => ["127.0.0.1:18789"],
}));

describe("printDaemonStatus", () => {
  function expectMockLineContains(mock: typeof runtime.log, expected: string) {
    const output = mock.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain(expected);
  }

  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
    resolveControlUiLinksMock.mockClear();
    isSystemdUnavailableDetailMock.mockReset().mockReturnValue(false);
    renderSystemdUnavailableHintsMock.mockReset().mockReturnValue([]);
    isWSLEnvMock.mockClear();
  });

  it("prints stale gateway pid guidance when runtime does not own the listener", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        logFile: "/tmp/openclaw.log",
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        port: {
          port: 18789,
          status: "busy",
          listeners: [{ pid: 9000, ppid: 8999, address: "127.0.0.1:18789" }],
          hints: [],
        },
        rpc: {
          ok: false,
          error: "gateway closed (1006 abnormal closure (no close frame))",
          url: "ws://127.0.0.1:18789",
        },
        health: {
          healthy: false,
          staleGatewayPids: [9000],
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.error, "Gateway runtime PID does not own the listening port");
    expectMockLineContains(runtime.error, formatCliCommand("openclaw gateway restart"));
  });

  it("prints established gateway client guidance gathered by deep status", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        connections: {
          port: 18789,
          established: [
            {
              pid: 4242,
              ppid: 1,
              command: "node",
              commandLine: "/tmp/newer-openclaw/bin/openclaw logs --follow",
              address: "TCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)",
              direction: "client",
            },
          ],
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "Established clients: 1");
    expectMockLineContains(runtime.log, "pid=4242");
    expectMockLineContains(runtime.log, "newer-openclaw");
    expectMockLineContains(runtime.log, "client");
    expectMockLineContains(runtime.log, "protocol mismatch after rollback");
  });

  it("prints Windows firewall diagnostics in gateway status output", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "lan",
          bindHost: "0.0.0.0",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
          windowsFirewall: {
            applies: true,
            severity: "warning",
            code: "windows_firewall_local_rules_ignored",
            message:
              "Windows Firewall may ignore local Gateway allow rules for this network profile.",
            details: ["Windows reports LocalFirewallRules as N/A (GPO-store only)."],
          },
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );

    expectMockLineContains(runtime.error, "Windows firewall: Windows Firewall may ignore");
    expectMockLineContains(runtime.error, "GPO-store only");
  });

  it("uses service command env for WSL systemd unavailable hints", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    isSystemdUnavailableDetailMock.mockReturnValue(true);
    renderSystemdUnavailableHintsMock.mockReturnValue(["wsl hint"]);
    try {
      printDaemonStatus(
        {
          service: {
            label: "systemd",
            loaded: true,
            loadedText: "loaded",
            notLoadedText: "not loaded",
            runtime: {
              status: "unknown",
              detail: "System has not been booted with systemd as init system",
            },
            command: {
              programArguments: [],
              environment: { WSL_DISTRO_NAME: "Ubuntu" },
            },
          },
          rpc: {
            ok: false,
            error: "unavailable",
            url: "ws://127.0.0.1:18789",
          },
          extraServices: [],
        },
        { json: false },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }

    expect(isWSLEnvMock).toHaveBeenCalledWith({ WSL_DISTRO_NAME: "Ubuntu" });
    expect(renderSystemdUnavailableHintsMock).toHaveBeenCalledWith({
      wsl: true,
      kind: "generic_unavailable",
      container: false,
    });
    expectMockLineContains(runtime.error, "wsl hint");
  });

  it("prints stale updater launchd job guidance", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
          staleUpdateLaunchdJobs: [
            {
              label: "ai.openclaw.update.2026.5.12",
              lastExitStatus: 127,
            },
            {
              label: "ai.openclaw.manual-update.1717168800",
              lastExitStatus: 0,
            },
          ],
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.error, "Stale OpenClaw updater launchd job(s) detected.");
    expectMockLineContains(runtime.error, "ai.openclaw.update.2026.5.12");
    expectMockLineContains(runtime.error, "ai.openclaw.manual-update.1717168800");
    expectMockLineContains(runtime.error, "launchctl remove <label>");
    expectMockLineContains(runtime.error, formatCliCommand("openclaw gateway restart"));
  });

  it("prints macOS launchd stdout and suppressed stderr when gateway is not listening", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      printDaemonStatus(
        {
          service: {
            label: "LaunchAgent",
            loaded: true,
            loadedText: "loaded",
            notLoadedText: "not loaded",
            runtime: { status: "running", pid: 8000 },
            command: { programArguments: [], environment: { HOME: "/Users/test" } },
          },
          gateway: {
            bindMode: "loopback",
            bindHost: "127.0.0.1",
            port: 18789,
            portSource: "env/config",
            probeUrl: "ws://127.0.0.1:18789",
          },
          port: {
            port: 18789,
            status: "free",
            listeners: [],
            hints: [],
          },
          rpc: {
            ok: false,
            kind: "connect",
            capability: "unknown",
            error: "gateway closed (1000): ",
            url: "ws://127.0.0.1:18789",
          },
          lastError: "failed to bind gateway socket EADDRINUSE",
          extraServices: [],
        },
        { json: false },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }

    expectMockLineContains(runtime.error, "Gateway port 18789 is not listening");
    expectMockLineContains(runtime.error, "/Users/test/Library/Logs/openclaw/gateway.log");
    expectMockLineContains(runtime.error, "Errors: suppressed");
    const errors = runtime.error.mock.calls.map(([line]) => line).join("\n");
    expect(errors.match(/Last gateway error:/g)).toHaveLength(1);
  });

  it("prints GUI-session wording before generic missing-supervision wording", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: false,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: {
            status: "unknown",
            missingSupervision: true,
            missingGuiSession: true,
            detail: "Bootstrap failed: 125: Domain does not support specified action",
          },
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.error, "macOS has no usable GUI session");
    const errors = runtime.error.mock.calls.map(([line]) => line).join("\n");
    expect(errors).not.toContain("launchd has no loaded job");
  });

  it("prints probe kind and capability separately", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        rpc: {
          ok: true,
          kind: "connect",
          capability: "write_capable",
          url: "ws://127.0.0.1:18789",
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "Connectivity probe: ok");
    expectMockLineContains(runtime.log, "Capability: write-capable");
  });

  it("prints the last gateway error when a running service fails the RPC probe", () => {
    printDaemonStatus(
      {
        service: {
          label: "systemd user",
          loaded: true,
          loadedText: "enabled",
          notLoadedText: "disabled",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "lan",
          bindHost: "0.0.0.0",
          port: 2345,
          portSource: "service args",
          probeUrl: "ws://127.0.0.1:2345",
        },
        port: {
          port: 2345,
          status: "busy",
          listeners: [{ pid: 8000, ppid: 1, address: "*:2345" }],
          hints: [],
        },
        rpc: {
          ok: false,
          kind: "connect",
          capability: "unknown",
          error: "gateway closed (1000): ",
          url: "ws://127.0.0.1:2345",
        },
        lastError: "parse/handle error: Error: ENOSPC: no space left on device, write",
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.error, "Connectivity probe: failed");
    expectMockLineContains(runtime.error, "gateway closed (1000):");
    expectMockLineContains(
      runtime.error,
      "Last gateway error: parse/handle error: Error: ENOSPC: no space left on device, write",
    );
  });

  it("prints CLI and gateway versions with readable guidance when they differ", () => {
    printDaemonStatus(
      {
        cli: {
          version: "2026.4.23",
          entrypoint: "/usr/local/bin/openclaw",
        },
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        rpc: {
          ok: true,
          kind: "connect",
          capability: "write_capable",
          url: "ws://127.0.0.1:18789",
          server: { version: "2026.5.6", connId: "conn-1" },
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "CLI version: 2026.4.23 (/usr/local/bin/openclaw)");
    expectMockLineContains(runtime.log, "Gateway version: 2026.5.6");
    expectMockLineContains(runtime.error, "this OpenClaw command is version 2026.4.23");
    expectMockLineContains(
      runtime.error,
      "if this mismatch is unexpected, update PATH so `openclaw` points to the version you want",
    );
  });

  it("prints gateway version from gathered gateway status when probe server metadata is absent", () => {
    printDaemonStatus(
      {
        cli: {
          version: "2026.4.23",
          entrypoint: "/usr/local/bin/openclaw",
        },
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
          version: "2026.5.7",
        },
        rpc: {
          ok: true,
          kind: "read",
          capability: "read_only",
          url: "ws://127.0.0.1:18789",
          version: "2026.5.7",
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "Gateway version: 2026.5.7");
    expectMockLineContains(runtime.error, "this OpenClaw command is version 2026.4.23");
  });

  it("prints restart handoff diagnostics when deep status gathered one", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "stopped" },
          restartHandoff: {
            kind: "gateway-supervisor-restart-handoff",
            version: 1,
            intentId: "intent-1",
            pid: 12_345,
            createdAt: 10_000,
            expiresAt: 70_000,
            reason: "plugin source changed",
            source: "plugin-change",
            restartKind: "full-process",
            supervisorMode: "launchd",
          },
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "Recent restart handoff: full-process via launchd");
    expectMockLineContains(runtime.log, "reason=plugin source changed");
  });

  it("passes daemon TLS state to dashboard link rendering", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        config: {
          cli: {
            path: "/tmp/openclaw-cli/openclaw.json",
            exists: true,
            valid: true,
          },
          daemon: {
            path: "/tmp/openclaw-daemon/openclaw.json",
            exists: true,
            valid: true,
            controlUi: { basePath: "/ui" },
          },
          mismatch: true,
        },
        gateway: {
          bindMode: "lan",
          bindHost: "0.0.0.0",
          port: 19001,
          portSource: "service args",
          probeUrl: "wss://127.0.0.1:19001",
          tlsEnabled: true,
        },
        rpc: {
          ok: true,
          kind: "connect",
          capability: "write_capable",
          url: "wss://127.0.0.1:19001",
        },
        extraServices: [],
      },
      { json: false },
    );

    expect(resolveControlUiLinksMock).toHaveBeenCalledWith({
      port: 19001,
      bind: "lan",
      customBindHost: undefined,
      basePath: "/ui",
      tlsEnabled: true,
    });
  });

  it("prints gathered advertised dashboard links without recomputing them", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
        },
        config: {
          cli: {
            path: "/tmp/openclaw-cli/openclaw.json",
            exists: true,
            valid: true,
          },
          daemon: {
            path: "/tmp/openclaw-daemon/openclaw.json",
            exists: true,
            valid: true,
            controlUi: { basePath: "/ui" },
          },
          mismatch: true,
        },
        gateway: {
          bindMode: "lan",
          bindHost: "0.0.0.0",
          port: 19001,
          portSource: "service args",
          probeUrl: "wss://127.0.0.1:19001",
          tlsEnabled: true,
          controlUiLinks: {
            httpUrl: "https://10.211.55.3:19001/ui/",
            wsUrl: "wss://10.211.55.3:19001/ui",
          },
        },
        extraServices: [],
      },
      { json: false },
    );

    expect(runtime.log).toHaveBeenCalledWith("Dashboard: https://10.211.55.3:19001/ui/");
    expect(resolveControlUiLinksMock).not.toHaveBeenCalled();
  });

  it("prints deep config warnings", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        config: {
          cli: {
            path: "/tmp/openclaw-cli/openclaw.json",
            exists: true,
            valid: true,
            warnings: [
              {
                path: "plugins.entries.test-bad-plugin",
                message:
                  "plugin test-bad-plugin: channel plugin manifest declares test-bad-plugin without channelConfigs metadata",
              },
            ],
          },
          mismatch: false,
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.error, "Config warnings:");
    expectMockLineContains(runtime.error, "without channelConfigs metadata");
  });

  it("prints extra gateway-like services as warnings instead of errors", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        rpc: {
          ok: true,
          url: "ws://127.0.0.1:18789",
          server: { version: "2026.5.12" },
        },
        port: {
          port: 18789,
          status: "busy",
          listeners: [],
          hints: [],
        },
        extraServices: [{ label: "ai.openclaw.gateway.rescue", scope: "user", detail: "loaded" }],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "Other gateway-like services detected");
    expectMockLineContains(runtime.log, "ai.openclaw.gateway.rescue");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("prints a terse plugin drift warning outside deep mode", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.5.4",
          drifts: [
            {
              pluginId: "whatsapp",
              installedVersion: "2026.5.3",
              gatewayVersion: "2026.5.4",
              source: "npm",
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: false },
    );

    expectMockLineContains(runtime.log, "Plugin version drift: 1 active official plugin");
    expectMockLineContains(runtime.log, "openclaw gateway status --deep");
    expect(runtime.log.mock.calls.map(([line]) => line).join("\n")).not.toContain("whatsapp:");
  });

  it("prints detailed plugin drift entries in deep mode", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.5.4",
          drifts: [
            {
              pluginId: "whatsapp",
              installedVersion: "2026.5.3",
              gatewayVersion: "2026.5.4",
              source: "clawhub",
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );

    expectMockLineContains(runtime.log, "- whatsapp: 2026.5.3 (clawhub)");
    expectMockLineContains(runtime.log, "openclaw plugins update whatsapp");
    expectMockLineContains(runtime.log, "openclaw gateway restart");
  });

  it("prints exact package update commands for pinned npm plugin drift in deep mode", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.6.10-beta.1",
          drifts: [
            {
              pluginId: "brave",
              installedVersion: "2026.6.9",
              gatewayVersion: "2026.6.10-beta.1",
              source: "npm",
              packageName: "@openclaw/brave-plugin",
              spec: "@openclaw/brave-plugin@2026.6.9",
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );

    expectMockLineContains(runtime.log, "- brave: 2026.6.9 (npm)");
    expectMockLineContains(
      runtime.log,
      "openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1",
    );
    expectMockLineContains(runtime.log, "openclaw gateway restart");
  });

  it("does not print systemd user-service hints when a gateway responds", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    isSystemdUnavailableDetailMock.mockReturnValue(true);
    renderSystemdUnavailableHintsMock.mockReturnValue(["run loginctl enable-linger"]);

    try {
      printDaemonStatus(
        {
          service: {
            label: "systemd user",
            loaded: false,
            loadedText: "not loaded",
            notLoadedText: "not loaded",
            runtime: { status: "unknown", detail: "systemd user services unavailable" },
          },
          rpc: {
            ok: true,
            url: "ws://127.0.0.1:18789",
            server: { version: "2026.5.12" },
          },
          port: {
            port: 18789,
            status: "busy",
            listeners: [],
            hints: [],
          },
          extraServices: [],
        },
        { json: false },
      );
    } finally {
      platform.mockRestore();
    }

    const errors = runtime.error.mock.calls.map(([line]) => line).join("\n");
    expect(errors).not.toContain("systemd user services unavailable");
    expect(errors).not.toContain("run loginctl enable-linger");
  });

  it("warns that systemd gave up restarting a crash-looped gateway", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      printDaemonStatus(
        {
          service: {
            label: "systemd",
            loaded: true,
            loadedText: "loaded",
            notLoadedText: "not loaded",
            runtime: {
              status: "stopped",
              state: "failed",
              systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
            },
          },
          extraServices: [],
        },
        { json: false },
      );
    } finally {
      platform.mockRestore();
    }

    const errors = runtime.error.mock.calls.map(([line]) => line).join("\n");
    expect(errors).toContain("systemd stopped restarting the gateway after repeated crashes");
    expect(errors).not.toContain("likely exited immediately");
  });

  it("keeps the generic stopped message after a config exit (78) despite a stale restart count", () => {
    // RestartPreventExitStatus=78 stopped systemd deliberately; a leftover
    // NRestarts must not surface start-limit recovery guidance here.
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      printDaemonStatus(
        {
          service: {
            label: "systemd",
            loaded: true,
            loadedText: "loaded",
            notLoadedText: "not loaded",
            runtime: {
              status: "stopped",
              state: "failed",
              lastExitStatus: 78,
              systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
            },
          },
          extraServices: [],
        },
        { json: false },
      );
    } finally {
      platform.mockRestore();
    }

    const errors = runtime.error.mock.calls.map(([line]) => line).join("\n");
    expect(errors).toContain("Service is loaded but not running (likely exited immediately).");
    expect(errors).not.toContain("systemd stopped restarting the gateway");
  });

  it("steers a failed RPC probe to credentials/config when the gateway process owns the port", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        rpc: {
          ok: false,
          error: "gateway closed (1008 policy violation: invalid token)",
          url: "ws://127.0.0.1:18789",
        },
        health: {
          healthy: true,
          staleGatewayPids: [],
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(
      runtime.log,
      "Gateway process is running and owns the gateway port, so this is not a warm-up delay",
    );
    expectMockLineContains(runtime.log, "Check the probe credentials/config");
    const logged = runtime.log.mock.calls.map(([line]) => line).join("\n");
    expect(logged).not.toContain("Warm-up: launch agents");
  });

  it("keeps the warm-up hint (not owns-port guidance) when healthy is reachability-only and a stale gateway PID is still held", () => {
    // inspectGatewayRestart can set healthy from reachability after ownership failed,
    // while still returning non-empty staleGatewayPids. That must not be treated as
    // owns-port proof, or this message would contradict the stale-PID diagnostic below.
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        rpc: {
          ok: false,
          error: "gateway closed (1008 policy violation: invalid token)",
          url: "ws://127.0.0.1:18789",
        },
        health: {
          healthy: true,
          staleGatewayPids: [9000],
        },
        extraServices: [],
      },
      { json: false },
    );

    const logged = runtime.log.mock.calls.map(([line]) => line).join("\n");
    expect(logged).toContain("Warm-up: launch agents can take a few seconds");
    expect(logged).not.toContain("Gateway process is running and owns the gateway port");
    const errors = runtime.error.mock.calls.map(([line]) => line).join("\n");
    expect(errors).toContain("Gateway runtime PID does not own the listening port");
  });

  it("keeps the warm-up hint for an unhealthy gateway, even with the port held", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        rpc: {
          ok: false,
          error: "gateway closed (1006 abnormal closure (no close frame))",
          url: "ws://127.0.0.1:18789",
        },
        port: {
          port: 18789,
          status: "busy",
          listeners: [],
          hints: [],
        },
        health: {
          healthy: false,
          staleGatewayPids: [],
        },
        extraServices: [],
      },
      { json: false },
    );

    // health.healthy === false is ambiguous (not-yet-bound / foreign port conflict / stale
    // PID), so it keeps the warm-up hint rather than steering to a restart; the dedicated
    // stale-PID / port-not-listening / port-conflict blocks own those cases.
    expectMockLineContains(runtime.log, "Warm-up: launch agents can take a few seconds");
    const logged = runtime.log.mock.calls.map(([line]) => line).join("\n");
    expect(logged).not.toContain("Gateway process is");
  });

  it("keeps the warm-up hint when gateway health is unknown", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        rpc: {
          ok: false,
          error: "gateway closed (1006 abnormal closure (no close frame))",
          url: "ws://127.0.0.1:18789",
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "Warm-up: launch agents can take a few seconds");
    const logged = runtime.log.mock.calls.map(([line]) => line).join("\n");
    expect(logged).not.toContain("Gateway process is");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
