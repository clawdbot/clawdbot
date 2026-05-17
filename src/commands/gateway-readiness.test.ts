import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { ensureGatewayReadyForOperation } from "./gateway-readiness.js";

function createStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    service: {
      label: "systemd user",
      loaded: false,
      loadedText: "enabled",
      notLoadedText: "disabled",
      command: null,
      runtime: { status: "stopped" },
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
      error: "connect ECONNREFUSED 127.0.0.1:18789",
    },
    extraServices: [],
    ...overrides,
  };
}

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("ensureGatewayReadyForOperation", () => {
  beforeEach(() => {
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("returns ready without prompting when the gateway probe succeeds", async () => {
    const gatherStatus = vi.fn().mockResolvedValue(
      createStatus({
        rpc: { ok: true },
        port: { port: 18789, status: "busy", listeners: [], hints: [] },
      }),
    );
    const confirm = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "run a command",
      deps: { gatherStatus, confirm },
    });

    expect(result.ready).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("prints diagnosis and skips recovery when an interactive user declines", async () => {
    const gatherStatus = vi.fn().mockResolvedValue(createStatus());
    const confirm = vi.fn().mockResolvedValue(false);

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      interactive: true,
      deps: { gatherStatus, confirm },
    });

    expect(result.ready).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "Gateway is not installed. Install and start it now so OpenClaw can open the dashboard?",
      true,
    );
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Gateway is not running.",
    );
  });

  it("installs a missing service and waits for the gateway before returning ready", async () => {
    const stopped = createStatus();
    const running = createStatus({
      service: {
        label: "systemd user",
        loaded: true,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: { ok: true },
    });
    const gatherStatus = vi.fn().mockResolvedValueOnce(stopped).mockResolvedValueOnce(running);
    const installGateway = vi.fn().mockResolvedValue(undefined);
    const startGateway = vi.fn().mockResolvedValue(undefined);

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      yes: true,
      deps: { gatherStatus, installGateway, startGateway },
    });

    expect(result).toMatchObject({ ready: true, recovered: true });
    expect(installGateway).toHaveBeenCalledTimes(1);
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("starts an installed stopped service instead of reinstalling it", async () => {
    const stopped = createStatus({
      service: {
        label: "systemd user",
        loaded: false,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "stopped" },
      },
    });
    const running = createStatus({
      service: {
        label: "systemd user",
        loaded: true,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: { ok: true },
    });
    const gatherStatus = vi.fn().mockResolvedValueOnce(stopped).mockResolvedValueOnce(running);
    const installGateway = vi.fn().mockResolvedValue(undefined);
    const startGateway = vi.fn().mockResolvedValue(undefined);

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      yes: true,
      deps: { gatherStatus, installGateway, startGateway },
    });

    expect(result).toMatchObject({ ready: true, recovered: true });
    expect(startGateway).toHaveBeenCalledTimes(1);
    expect(installGateway).not.toHaveBeenCalled();
  });

  it("does not prompt to start when the gateway is reachable but unhealthy", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loaded: true,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: { ok: false, error: "gateway closed (1008): auth failed" },
    });
    const confirm = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      interactive: true,
      deps: { gatherStatus: vi.fn().mockResolvedValue(status), confirm },
    });

    expect(result).toMatchObject({ ready: false, recoverable: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Gateway probe failed: gateway closed (1008): auth failed",
    );
  });

  it("can accept a reachable dashboard listener when authenticated RPC fails", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loaded: true,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "free", listeners: [], hints: [] },
      portCli: { port: 49876, status: "busy", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "gateway closed (1008): auth failed",
        url: "ws://127.0.0.1:49876",
      },
    });
    const confirm = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      readyWhenReachable: true,
      interactive: true,
      deps: { gatherStatus: vi.fn().mockResolvedValue(status), confirm },
    });

    expect(result).toMatchObject({ ready: true, recovered: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("can accept a reachable dashboard listener when the RPC needs device identity", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loaded: true,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "device identity required",
        url: "ws://127.0.0.1:18789",
      },
    });
    const confirm = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      readyWhenReachable: true,
      interactive: true,
      deps: { gatherStatus: vi.fn().mockResolvedValue(status), confirm },
    });

    expect(result).toMatchObject({ ready: true, recovered: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("still treats a timeout on the target port as not ready", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loaded: true,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: { ok: false, error: "timeout", url: "ws://127.0.0.1:18789" },
    });
    const confirm = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      readyWhenReachable: true,
      interactive: true,
      deps: { gatherStatus: vi.fn().mockResolvedValue(status), confirm },
    });

    expect(result).toMatchObject({ ready: false, recoverable: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Gateway probe failed: timeout",
    );
  });

  it("does not accept an unrelated listener on the dashboard port", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loaded: true,
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "Unexpected server response: 200",
        url: "ws://127.0.0.1:18789",
      },
    });
    const confirm = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      readyWhenReachable: true,
      interactive: true,
      deps: { gatherStatus: vi.fn().mockResolvedValue(status), confirm },
    });

    expect(result).toMatchObject({ ready: false, recoverable: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Gateway probe failed: Unexpected server response: 200",
    );
  });
});
