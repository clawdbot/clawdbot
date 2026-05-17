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

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../../terminal/theme.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../terminal/theme.js")>("../../terminal/theme.js");
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
  isSystemdUnavailableDetail: () => false,
  renderSystemdUnavailableHints: () => [],
}));

vi.mock("../../infra/wsl.js", () => ({
  isWSLEnv: () => false,
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
});
