// ACPX tests cover service plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown; healthy?: () => boolean }>(),
}));
const { prepareAcpxCodexAuthConfigMock } = vi.hoisted(() => ({
  prepareAcpxCodexAuthConfigMock: vi.fn(
    async ({ pluginConfig }: { pluginConfig: unknown }) => pluginConfig,
  ),
}));
const { cleanupOpenClawOwnedAcpxProcessTreeMock } = vi.hoisted(() => ({
  cleanupOpenClawOwnedAcpxProcessTreeMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
    }),
  ),
}));
const { cleanupOpenClawOwnedAcpxPendingLeaseMock } = vi.hoisted(() => ({
  cleanupOpenClawOwnedAcpxPendingLeaseMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "missing-root",
    }),
  ),
}));
const { reapStaleOpenClawOwnedAcpxOrphansMock } = vi.hoisted(() => ({
  reapStaleOpenClawOwnedAcpxOrphansMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
    }),
  ),
}));
const { acpxRuntimeConstructorMock, createAgentRegistryMock, createFileSessionStoreMock } =
  vi.hoisted(() => ({
    acpxRuntimeConstructorMock: vi.fn(function AcpxRuntime(options: unknown) {
      return {
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
        ensureSession: vi.fn(async () => ({
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:test",
          sessionKey: "agent:codex:acp:test",
        })),
        getCapabilities: vi.fn(async () => ({ controls: [] })),
        getStatus: vi.fn(async () => ({ summary: "ready" })),
        isHealthy: vi.fn(() => true),
        prepareFreshSession: vi.fn(async () => {}),
        runTurn: vi.fn(async function* () {}),
        setConfigOption: vi.fn(async () => {}),
        setMode: vi.fn(async () => {}),
        startTurn: vi.fn((input: { requestId: string }) => ({
          requestId: input.requestId,
          promptStarted: Promise.resolve(),
          events: (async function* () {
            yield {
              type: "text_delta" as const,
              stream: "output" as const,
              text: "progress",
            };
          })(),
          result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
          cancel: vi.fn(async () => {}),
          closeStream: vi.fn(async () => {}),
        })),
        __options: options,
      };
    }),
    createAgentRegistryMock: vi.fn(() => ({})),
    createFileSessionStoreMock: vi.fn(() => ({})),
  }));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
}));

vi.mock("./runtime.js", () => ({
  ACPX_BACKEND_ID: "acpx",
  AcpxRuntime: acpxRuntimeConstructorMock,
  createAgentRegistry: createAgentRegistryMock,
  createFileSessionStore: createFileSessionStoreMock,
}));

vi.mock("./codex-auth-bridge.js", () => ({
  prepareAcpxCodexAuthConfig: prepareAcpxCodexAuthConfigMock,
}));

vi.mock("./process-reaper.js", () => ({
  cleanupOpenClawOwnedAcpxPendingLease: cleanupOpenClawOwnedAcpxPendingLeaseMock,
  cleanupOpenClawOwnedAcpxProcessTree: cleanupOpenClawOwnedAcpxProcessTreeMock,
  reapStaleOpenClawOwnedAcpxOrphans: reapStaleOpenClawOwnedAcpxOrphansMock,
}));

import { getAcpRuntimeBackend } from "../runtime-api.js";
import type { OpenClawPluginServiceContext } from "../runtime-api.js";
import {
  ACPX_PROBE_LEASE_SESSION_KEY,
  openAcpxProcessLeaseStateStore,
  type AcpxProcessLease,
} from "./process-lease.js";
import {
  createAcpxRuntimeService as createRealAcpxRuntimeService,
  resolveAcpxTimerTimeoutMs,
} from "./service.js";
import {
  ACPX_GATEWAY_INSTANCE_KEY,
  ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  ACPX_GATEWAY_INSTANCE_NAMESPACE,
  type AcpxGatewayInstanceRecord,
} from "./state.js";

let testWorkspace: TempWorkspace;
const previousEnv = {
  OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE,
  OPENCLAW_SKIP_ACPX_RUNTIME: process.env.OPENCLAW_SKIP_ACPX_RUNTIME,
  OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE,
};

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(async () => {
  testWorkspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-acpx-service-",
  });
});

afterEach(async () => {
  resetPluginStateStoreForTests();
  runtimeRegistry.clear();
  prepareAcpxCodexAuthConfigMock.mockClear();
  cleanupOpenClawOwnedAcpxProcessTreeMock.mockClear();
  cleanupOpenClawOwnedAcpxPendingLeaseMock.mockClear();
  reapStaleOpenClawOwnedAcpxOrphansMock.mockClear();
  acpxRuntimeConstructorMock.mockClear();
  createAgentRegistryMock.mockClear();
  createFileSessionStoreMock.mockClear();
  restoreEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE");
  restoreEnv("OPENCLAW_SKIP_ACPX_RUNTIME");
  restoreEnv("OPENCLAW_SKIP_ACPX_RUNTIME_PROBE");
  await testWorkspace.cleanup();
});

function createServiceContext(workspaceDir: string): OpenClawPluginServiceContext {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, ".openclaw-plugin-state"),
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createOpenKeyedStore(ctx: OpenClawPluginServiceContext) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: ctx.stateDir };
  return <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("acpx", {
      ...options,
      env: options.env ?? env,
    });
}

function createAcpxRuntimeService(
  ctx: OpenClawPluginServiceContext,
  params: Omit<Parameters<typeof createRealAcpxRuntimeService>[0], "backendLifecycle"> & {
    backendLifecycle?: Parameters<typeof createRealAcpxRuntimeService>[0]["backendLifecycle"];
  } = {},
) {
  const backendLifecycle = params.backendLifecycle ?? {
    publish(backend: { runtime: unknown; healthy?: () => boolean }) {
      runtimeRegistry.set("acpx", backend);
    },
    retract(runtime: unknown) {
      if (runtimeRegistry.get("acpx")?.runtime === runtime) {
        runtimeRegistry.delete("acpx");
      }
    },
  };
  return createRealAcpxRuntimeService({
    ...params,
    backendLifecycle,
    openKeyedStore: params.openKeyedStore ?? createOpenKeyedStore(ctx),
  });
}

function openGatewayInstanceStore(ctx: OpenClawPluginServiceContext) {
  return createOpenKeyedStore(ctx)<AcpxGatewayInstanceRecord>({
    namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
    maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  });
}

function openProcessLeaseStore(ctx: OpenClawPluginServiceContext) {
  return openAcpxProcessLeaseStateStore(createOpenKeyedStore(ctx));
}

function createMockRuntime(overrides: Record<string, unknown> = {}) {
  return {
    ensureSession: vi.fn(),
    runTurn: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    probeAvailability: vi.fn(async () => {}),
    isHealthy: vi.fn(() => true),
    doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    ...overrides,
  };
}

function createStartupTraceRecorder() {
  const measured: string[] = [];
  const details: Array<{
    name: string;
    metrics: ReadonlyArray<readonly [string, number | string]>;
  }> = [];
  return {
    measured,
    details,
    startupTrace: {
      measure: async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
        measured.push(name);
        return await run();
      },
      detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => {
        details.push({ name, metrics });
      },
    },
  };
}

function readFirstRuntimeFactoryInput(runtimeFactory: { mock: { calls: Array<Array<unknown>> } }) {
  const [call] = runtimeFactory.mock.calls;
  if (!call) {
    throw new Error("Expected runtimeFactory to be called");
  }
  const [input] = call;
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected runtimeFactory to be called with an options object");
  }
  return input as {
    pluginConfig: {
      timeoutSeconds?: number;
      probeAgent?: string;
    };
  };
}

describe("createAcpxRuntimeService", () => {
  it("caps configured timeout seconds to timer-safe milliseconds", () => {
    expect(resolveAcpxTimerTimeoutMs(0.001)).toBe(1);
    expect(resolveAcpxTimerTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("registers and unregisters the embedded backend", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await service.stop?.(ctx);

    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
  });

  it("publishes before probing and retracts the exact runtime through the injected lifecycle", async () => {
    delete process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const probeStarted = createDeferred<void>();
    const releaseProbe = createDeferred<void>();
    const events: string[] = [];
    const runtime = createMockRuntime({
      doctor: vi.fn(async () => {
        events.push("probe");
        probeStarted.resolve();
        await releaseProbe.promise;
        return { ok: true, message: "ok" };
      }),
    });
    const publish = vi.fn((backend: { runtime: unknown; healthy?: () => boolean }) => {
      events.push("publish");
      expect(backend.runtime).toBe(runtime);
      expect(backend.healthy?.()).toBe(true);
    });
    const retract = vi.fn((ownedRuntime: unknown) => {
      events.push("retract");
      expect(ownedRuntime).toBe(runtime);
    });
    const service = createAcpxRuntimeService(ctx, {
      backendLifecycle: { publish, retract },
      runtimeFactory: () => runtime as never,
    });

    const starting = service.start(ctx) as Promise<void>;
    await probeStarted.promise;

    expect(events).toEqual(["publish", "probe"]);
    expect(publish).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();

    await service.stop?.(ctx);
    expect(retract).toHaveBeenCalledWith(runtime);
    expect(events).toEqual(["publish", "probe", "retract"]);

    releaseProbe.resolve();
    await starting;
  });

  it("skips the startup probe and does not advertise backend health when explicitly disabled", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "0";
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE;
    const workspaceDir = testWorkspace.dir;
    const stateDir = path.join(workspaceDir, "custom-state");
    const ctx = createServiceContext(workspaceDir);
    const doctor = vi.fn(async () => {
      await fs.access(stateDir);
      return { ok: true, message: "ok" };
    });
    const runtime = createMockRuntime({
      doctor,
      isHealthy: () => false,
    });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { stateDir },
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await fs.access(stateDir);
    expect(doctor).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.healthy).toBeUndefined();

    await service.stop?.(ctx);
  });

  it("waits for the embedded runtime startup probe before resolving by default", async () => {
    delete process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    let releaseProbe!: () => void;
    const probeStarted = vi.fn();
    const doctor = vi.fn(
      () =>
        new Promise<{ ok: boolean; message: string }>((resolve) => {
          probeStarted();
          releaseProbe = () => resolve({ ok: true, message: "ok" });
        }),
    );
    const runtime = createMockRuntime({
      doctor,
      isHealthy: () => true,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    const startPromise = service.start(ctx) as Promise<void>;
    await vi.waitFor(() => {
      expect(probeStarted).toHaveBeenCalledOnce();
    });

    let resolved = false;
    void startPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    releaseProbe();
    await startPromise;

    expect(resolved).toBe(true);
    expect(ctx.logger.info).toHaveBeenCalledWith("embedded acpx runtime backend ready");

    await service.stop?.(ctx);
  });

  it("emits ACPX-owned startup trace subspans", async () => {
    delete process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const trace = createStartupTraceRecorder();
    ctx.startupTrace = trace.startupTrace;
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(trace.measured).toEqual([
      "config.resolve",
      "config.prepare-codex-auth",
      "filesystem.prepare",
      "gateway-instance-id",
      "process-leases.reap",
      "runtime.create",
      "backend.register",
      "probe.availability",
    ]);
    expect(trace.details).toEqual([
      {
        name: "probe-policy",
        metrics: [
          ["startupProbeEnabledCount", 1],
          ["probeAgent", "default"],
        ],
      },
      {
        name: "probe.result",
        metrics: [["healthyCount", 1]],
      },
    ]);

    await service.stop?.(ctx);
  });

  it("reaps stale ACPX process leases from the generated wrapper root at startup", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-1",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 101,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupOpenClawOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      inspectedPids: [101, 102],
      terminatedPids: [101, 102],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).toHaveBeenCalledWith({
      rootPid: 101,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gw-test",
      wrapperRoot,
      deps: processCleanupDeps,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale OpenClaw-owned ACPX processes");

    await service.stop?.(ctx);
  });

  it("keeps PID-bearing leases when startup process listing is unavailable", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-process-list-unavailable",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 101,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupOpenClawOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "process-list-unavailable",
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 101,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("recovers a pending ACPX lease from exact wrapper identity before retiring it", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await fs.mkdir(wrapperRoot, { recursive: true });
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-pending",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupOpenClawOwnedAcpxPendingLeaseMock.mockResolvedValueOnce({
      inspectedPids: [201, 202],
      terminatedPids: [201, 202],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxPendingLeaseMock).toHaveBeenCalledWith({
      leaseId: "lease-pending",
      gatewayInstanceId: "gw-test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      deps: processCleanupDeps,
    });
    expect(reapStaleOpenClawOwnedAcpxOrphansMock).toHaveBeenCalledWith({
      wrapperRoot,
      deps: processCleanupDeps,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale OpenClaw-owned ACPX processes");
    await expect(openProcessLeaseStore(ctx).lookup("lease-pending")).resolves.toBeUndefined();

    await service.stop?.(ctx);
  });

  it("keeps pending leases open when exact process evidence is ambiguous", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-ambiguous",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupOpenClawOwnedAcpxPendingLeaseMock.mockResolvedValueOnce({
      inspectedPids: [201, 202],
      terminatedPids: [],
      skippedReason: "ambiguous-root",
    });
    reapStaleOpenClawOwnedAcpxOrphansMock.mockResolvedValueOnce({
      inspectedPids: [301],
      terminatedPids: [301],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 0,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("keeps an absent pending probe lease open for unidentifiable descendants", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-probe-missing",
      gatewayInstanceId: "gw-test",
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 0,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("keeps startup quiet when no process leases are open", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("registers the backend lazily and forwards sessions and turns when startup probe is disabled", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "0";
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const service = createAcpxRuntimeService(ctx);
    const sessionsDir = path.join(workspaceDir, "state", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    for (const id of ["global", "openclaw-owner-v1-existing", "agent:free:acp:test"]) {
      await fs.writeFile(path.join(sessionsDir, `${encodeURIComponent(id)}.json`), "{}");
    }

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      ensureSession(input: { agent: string; mode: string; sessionKey: string }): Promise<unknown>;
      startTurn(input: {
        handle: { sessionKey: string; backend: string; runtimeSessionName: string };
        text: string;
        mode: string;
        requestId: string;
      }): {
        promptStarted: Promise<void>;
        events: AsyncIterable<unknown>;
        result: Promise<unknown>;
      };
    };
    expect(typeof backendRuntime.ensureSession).toBe("function");
    expect(backend.healthy).toBeUndefined();
    expect(acpxRuntimeConstructorMock).not.toHaveBeenCalled();

    await backendRuntime.ensureSession({
      agent: "codex",
      mode: "oneshot",
      sessionKey: "agent:codex:acp:test",
    });

    expect(acpxRuntimeConstructorMock).toHaveBeenCalledOnce();
    expect(acpxRuntimeConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        elicitationModes: ["form", "url"],
        openclawLegacyBareSessionKeys: new Set(["global", "openclaw-owner-v1-existing"]),
      }),
    );
    expect(backend.healthy).toBeUndefined();
    const turn = backendRuntime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
      },
      text: "hello",
      mode: "prompt",
      requestId: "turn-1",
    });
    await expect(turn.promptStarted).resolves.toBeUndefined();
    await expect(turn.result).resolves.toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
    const events = [];
    for await (const event of turn.events) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "text_delta",
        stream: "output",
        text: "progress",
      },
    ]);
    expect(acpxRuntimeConstructorMock.mock.results[0]?.value.startTurn).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  it("passes the plugin timeout to the default acpx runtime constructor", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "0";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: 0.001 },
    });

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      ensureSession(input: { agent: string; mode: string; sessionKey: string }): Promise<unknown>;
    };

    await backendRuntime.ensureSession({
      agent: "codex",
      mode: "oneshot",
      sessionKey: "agent:codex:acp:test",
    });

    const [options] = acpxRuntimeConstructorMock.mock.calls[0] ?? [];
    expect(options).toHaveProperty("timeoutMs", 1);

    await service.stop?.(ctx);
  });

  it("caps oversized plugin timeouts before constructing the default acpx runtime", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "0";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: Number.MAX_SAFE_INTEGER },
    });

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      ensureSession(input: { agent: string; mode: string; sessionKey: string }): Promise<unknown>;
    };

    await backendRuntime.ensureSession({
      agent: "codex",
      mode: "oneshot",
      sessionKey: "agent:codex:acp:test",
    });

    const [options] = acpxRuntimeConstructorMock.mock.calls[0] ?? [];
    expect(options).toHaveProperty("timeoutMs", MAX_TIMER_TIMEOUT_MS);

    await service.stop?.(ctx);
  });

  it("runs the embedded runtime probe at startup when explicitly enabled and reports health", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const doctor = vi.fn(async () => ({ ok: true, message: "ok" }));
    const runtime = createMockRuntime({
      doctor,
      isHealthy: () => true,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(doctor).toHaveBeenCalledOnce();
    expect(runtime.probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(true);

    await service.stop?.(ctx);
  });

  it("bounds startup diagnostics after an unhealthy probe", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const ctx = createServiceContext(testWorkspace.dir);
    const doctorStarted = createDeferred<void>();
    const releaseDoctor = createDeferred<{ ok: boolean; message: string }>();
    const runtime = createMockRuntime({
      isHealthy: () => false,
      doctor: vi.fn(() => {
        doctorStarted.resolve();
        return releaseDoctor.promise;
      }),
    });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: 0.001 },
      runtimeFactory: () => runtime as never,
    });
    vi.useFakeTimers();
    let settled = false;
    const started = Promise.resolve(service.start(ctx)).then(() => {
      settled = true;
    });
    try {
      await doctorStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(runtime.doctor).toHaveBeenCalledOnce();
      expect(runtime.probeAvailability).not.toHaveBeenCalled();
      expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(false);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        "embedded acpx runtime setup failed: embedded acpx runtime backend startup probe timed out after 0.001s",
      );
    } finally {
      releaseDoctor.resolve({ ok: false, message: "unavailable" });
      await started;
      await service.stop?.(ctx);
      vi.useRealTimers();
    }
  });

  it("passes the default runtime timeout to the embedded runtime factory", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.timeoutSeconds).toBe(120);

    await service.stop?.(ctx);
  });

  it("uses the first allowed ACP agent as the default probe agent", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    ctx.config = {
      acp: {
        allowedAgents: ["  OpenCode  ", "codex"],
      },
    };
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe("opencode");

    await service.stop?.(ctx);
  });

  it("keeps explicit probeAgent ahead of acp.allowedAgents", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    ctx.config = {
      acp: {
        allowedAgents: ["opencode"],
      },
    };
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { probeAgent: "codex" },
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe("codex");

    await service.stop?.(ctx);
  });

  it("lets the skip env override the opt-in embedded runtime startup probe without advertising health", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "1";
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const doctor = vi.fn(async () => ({ ok: false, message: "nope" }));
    const runtime = createMockRuntime({
      doctor,
      isHealthy: () => false,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(doctor).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
    expect(getAcpRuntimeBackend("acpx")?.healthy).toBeUndefined();

    await service.stop?.(ctx);
  });

  it("formats non-string doctor details without losing object payloads", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime({
      doctor: async () => ({
        ok: false,
        message: "probe failed",
        details: [{ code: "ACP_CLOSED", agent: "codex" }, new Error("stdin closed")],
      }),
      isHealthy: () => false,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'embedded acpx runtime backend probe failed: probe failed ({"code":"ACP_CLOSED","agent":"codex"}; stdin closed)',
    );

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime backend via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtimeFactory = vi.fn(() => {
      throw new Error("runtime factory should not run when ACPX is skipped");
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: runtimeFactory as never,
    });

    await service.start(ctx);

    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
    );
  });
});
