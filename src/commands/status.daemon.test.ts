// Status daemon tests cover managed gateway daemon summary resolution.
import { describe, expect, it, vi } from "vitest";
import { getDaemonStatusSummary } from "./status.daemon.js";

const mocks = vi.hoisted(() => ({
  readServiceStatusSummary: vi.fn(),
  resolveGatewayService: vi.fn(() => ({ kind: "gateway" })),
  resolveNodeService: vi.fn(() => ({ kind: "node" })),
}));

vi.mock("./status.service-summary.js", () => ({
  readServiceStatusSummary: mocks.readServiceStatusSummary,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: mocks.resolveNodeService,
}));

describe("status daemon summary", () => {
  it("preserves service layout diagnostics for status output", async () => {
    mocks.readServiceStatusSummary.mockResolvedValueOnce({
      label: "systemd",
      installed: true,
      loaded: true,
      managedByOpenClaw: true,
      externallyManaged: false,
      loadedText: "enabled",
      runtime: { status: "running", pid: 1234 },
      layout: {
        execStart: "/usr/bin/node /opt/openclaw/dist/entry.js gateway",
        sourceScope: "system",
        entrypointSourceCheckout: false,
      },
    });

    const summary = await getDaemonStatusSummary();
    expect(summary.runtimeShort).toBe("running (pid 1234)");
    expect(summary.layout?.execStart).toBe("/usr/bin/node /opt/openclaw/dist/entry.js gateway");
    expect(summary.layout?.sourceScope).toBe("system");
    expect(summary.layout?.entrypointSourceCheckout).toBe(false);
  });

  it("includes suspicious systemd cgroup hygiene in the service runtime summary", async () => {
    mocks.readServiceStatusSummary.mockResolvedValueOnce({
      label: "systemd user",
      installed: true,
      loaded: true,
      managedByOpenClaw: true,
      externallyManaged: false,
      loadedText: "enabled",
      runtime: {
        status: "running",
        pid: 1234,
        systemd: {
          unit: "openclaw-gateway.service",
          killMode: "process",
          tasksCurrent: 807,
          memoryCurrent: 11_918_534_246,
        },
      },
    });

    const summary = await getDaemonStatusSummary();
    expect(summary.runtimeShort).toBe(
      "running (pid 1234, cgroup hygiene: KillMode=process, tasks=807, memory=11.1GiB)",
    );
    expect(summary.runtime?.systemd).toEqual({
      unit: "openclaw-gateway.service",
      killMode: "process",
      tasksCurrent: 807,
      memoryCurrent: 11_918_534_246,
    });
  });

  it("keeps normal systemd cgroup metrics out of the short status line", async () => {
    mocks.readServiceStatusSummary.mockResolvedValueOnce({
      label: "systemd user",
      installed: true,
      loaded: true,
      managedByOpenClaw: true,
      externallyManaged: false,
      loadedText: "enabled",
      runtime: {
        status: "running",
        pid: 1234,
        systemd: {
          unit: "openclaw-gateway.service",
          killMode: "control-group",
          tasksCurrent: 7,
          memoryCurrent: 132_120_576,
        },
      },
    });

    const summary = await getDaemonStatusSummary();
    expect(summary.runtimeShort).toBe("running (pid 1234)");
  });

  it("keeps gateway status readable for unsupported service adapters", async () => {
    mocks.readServiceStatusSummary.mockResolvedValueOnce({
      label: "Gateway service",
      installed: false,
      loaded: false,
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "not installed",
      runtime: { status: "unknown", detail: "Gateway service install not supported on aix" },
    });

    const summary = await getDaemonStatusSummary();

    expect(mocks.resolveGatewayService).toHaveBeenCalled();
    expect(summary.label).toBe("Gateway service");
    expect(summary.installed).toBe(false);
    expect(summary.runtimeShort).toBe("unknown (Gateway service install not supported on aix)");
  });
});
