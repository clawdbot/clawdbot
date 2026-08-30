// Gateway readiness tests cover readiness checks, status details, and failure messages.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withEnvAsync } from "../test-utils/env.js";
import { ensureGatewayReadyForOperation } from "./gateway-readiness.js";

type StatusOverrides = Omit<Partial<DaemonStatus>, "service"> & {
  service?: Omit<DaemonStatus["service"], "loaded" | "installed"> & { installed?: boolean };
};

function createStatus(overrides: StatusOverrides = {}): DaemonStatus {
  const { service, ...rest } = overrides;
  const serviceStatus = service ?? {
    label: "systemd user",
    loadState: { status: "not-loaded" as const },
    loadedText: "enabled",
    notLoadedText: "disabled",
    command: null,
    runtime: { status: "stopped" },
  };
  return {
    service: {
      ...serviceStatus,
      installed:
        service?.installed ??
        Boolean(serviceStatus.command || serviceStatus.loadState.status === "loaded"),
      loaded:
        serviceStatus.loadState.status === "unknown"
          ? null
          : serviceStatus.loadState.status === "loaded",
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
    ...rest,
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
      "Install and start the background Gateway service to open the dashboard?",
      true,
    );
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Gateway is not running.",
    );
  });

  it.each(["load", "runtime", "definition"])(
    "does not offer recovery after %s inspection fails",
    async (failure) => {
      const status = createStatus();
      if (failure === "load") {
        status.service.loadState = { status: "unknown", detail: "service manager unavailable" };
        status.service.loaded = null;
      } else if (failure === "definition") {
        status.service.definitionError = "Service definition access denied";
      } else {
        status.service.runtime = {
          status: "unknown",
          inspectionFailure: { code: "service-runtime-inspection-failed", detail: "access denied" },
        };
      }
      const confirm = vi.fn();
      const installGateway = vi.fn();
      const startGateway = vi.fn();
      const result = await ensureGatewayReadyForOperation({
        runtime,
        operation: "open the dashboard",
        yes: true,
        deps: { gatherStatus: async () => status, confirm, installGateway, startGateway },
      });
      expect(result).toMatchObject({ ready: false, recoverable: false });
      expect(runtime.log).toHaveBeenCalledWith("Could not check the background Gateway service.");
      expect(confirm).not.toHaveBeenCalled();
      expect(installGateway).not.toHaveBeenCalled();
      expect(startGateway).not.toHaveBeenCalled();
    },
  );

  it.each(["install", "start", "reachable", "external"])(
    "preserves newer local state during %s readiness",
    async (scenario) => {
      const stateDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-readiness-")),
      );
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      database.close();
      const before = await fs.readFile(databasePath);
      const status = createStatus();
      if (scenario === "start") {
        status.service.command = { programArguments: ["openclaw", "gateway", "run"] };
        status.service.installed = true;
      } else if (scenario === "reachable") {
        status.rpc = { ok: true };
      } else if (scenario === "external") {
        status.service.targetRole = "diagnostic-only";
      }
      const confirm = vi.fn();
      const installGateway = vi.fn();
      const startGateway = vi.fn();
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          const result = await ensureGatewayReadyForOperation({
            runtime,
            operation: "open the dashboard",
            yes: true,
            deps: { gatherStatus: async () => status, confirm, installGateway, startGateway },
          });
          expect(result.ready).toBe(scenario === "reachable");
          if (scenario === "install" || scenario === "start") {
            expect(result).toMatchObject({
              recoverable: false,
              reason: expect.stringContaining(
                "This OpenClaw build cannot open your existing data.",
              ),
            });
          } else {
            expect(runtime.error).not.toHaveBeenCalled();
          }
          expect(confirm).not.toHaveBeenCalled();
          expect(installGateway).not.toHaveBeenCalled();
          expect(startGateway).not.toHaveBeenCalled();
          expect(await fs.readFile(databasePath)).toEqual(before);
          expect(await fs.readdir(path.dirname(databasePath))).toEqual(["openclaw.sqlite"]);
        });
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("installs a missing service and waits for the gateway before returning ready", async () => {
    const stopped = createStatus();
    const running = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
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
        loadState: { status: "not-loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "stopped" },
      },
    });
    const running = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
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

  it("does not recover a diagnostic-only native service for an active external target", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        targetRole: "diagnostic-only",
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        runtime: { status: "running" },
      },
      gateway: {
        bindMode: "loopback",
        bindHost: "127.0.0.1",
        port: 18900,
        portSource: "env/config",
        probeUrl: "ws://127.0.0.1:18900",
      },
      port: { port: 18900, status: "free", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "connect ECONNREFUSED 127.0.0.1:18900",
        url: "ws://127.0.0.1:18900",
      },
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const installGateway = vi.fn();
    const startGateway = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      interactive: true,
      deps: {
        gatherStatus: vi.fn().mockResolvedValue(status),
        confirm,
        installGateway,
        startGateway,
      },
    });

    expect(result).toMatchObject({ ready: false, recoverable: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(installGateway).not.toHaveBeenCalled();
    expect(startGateway).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "owning environment or supervisor to start or repair",
    );
  });

  it("does not prompt to start when the gateway is reachable but unhealthy", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
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
        loadState: { status: "loaded" },
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
        loadState: { status: "loaded" },
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

  it("uses the projected connect failure when the daemon error text is generic", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "connect failed",
        connectFailure: { kind: "pairing-required", detailCode: "PAIRING_REQUIRED" },
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
  });

  it("accepts a rate-limited Gateway as reachable without starting the service", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "connect failed",
        connectFailure: { kind: "rate-limited", detailCode: "AUTH_RATE_LIMITED" },
        url: "ws://127.0.0.1:18789",
      },
    });
    const startGateway = vi.fn();

    const result = await ensureGatewayReadyForOperation({
      runtime,
      operation: "open the dashboard",
      readyWhenReachable: true,
      deps: { gatherStatus: vi.fn().mockResolvedValue(status), startGateway },
    });

    expect(result).toMatchObject({ ready: true, recovered: false });
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("still treats a timeout on the target port as not ready", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
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
        loadState: { status: "loaded" },
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
