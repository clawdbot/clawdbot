import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { cellAuthSecretDir, cellOwnerId } from "./cell-profile.js";
import type { FleetContainerInspectResult, FleetContainerRuntime } from "./containers.runtime.js";
import { deleteFleetCell, getFleetCell, listFleetCells } from "./registry.js";
import {
  createFleetService as createFleetServiceRuntime,
  type FleetServiceOptions,
} from "./service.runtime.js";

let root: string;
const TEST_ATTEMPT_ID = "22222222222222222222222222222222";
const NEXT_ATTEMPT_ID = "44444444444444444444444444444444";

function createFleetService(options: FleetServiceOptions = {}) {
  return createFleetServiceRuntime({ probePort: async () => true, ...options });
}

function fleetLabels(tenant = "acme", attemptId = TEST_ATTEMPT_ID): Record<string, string> {
  return {
    "openclaw.fleet.tenant": tenant,
    "openclaw.fleet.owner": cellOwnerId(path.join(root, "fleet", "cells", tenant)),
    "openclaw.fleet.attempt": attemptId,
    "openclaw.fleet.env-keys": "FEATURE",
  };
}

function runningInspection(
  overrides: Partial<Extract<FleetContainerInspectResult, { kind: "ok" }>> = {},
): Extract<FleetContainerInspectResult, { kind: "ok" }> {
  return {
    kind: "ok",
    state: "running",
    running: true,
    labels: fleetLabels(),
    environment: {
      HOME: "/home/node",
      OPENCLAW_GATEWAY_TOKEN: "old-token",
      FEATURE: "enabled",
      NODE_VERSION: "old-image-default",
    },
    imageId: "sha256:old-image-id",
    memory: "2147483648",
    cpus: "2",
    pidsLimit: 512,
    storageOpt: {},
    capDrop: ["ALL"],
    effectiveCaps: undefined,
    securityOpt: ["no-new-privileges"],
    init: true,
    restartPolicy: "unless-stopped",
    portBindings: [{ containerPort: "18789/tcp", hostIp: "127.0.0.1", hostPort: "19100" }],
    ...overrides,
  };
}

function createContainerMock(
  initialInspection: FleetContainerInspectResult = {
    kind: "missing",
    state: "missing",
  },
) {
  const assertLocal = vi.fn<FleetContainerRuntime["assertLocal"]>(async () => undefined);
  const inspections = new Map<string, FleetContainerInspectResult>();
  const removedContainers = new Set<string>();
  const inspect = vi.fn<FleetContainerRuntime["inspect"]>(async (_runtime, name) =>
    removedContainers.has(name)
      ? { kind: "missing", state: "missing" }
      : (inspections.get(name) ?? initialInspection),
  );
  const networks = new Map<
    string,
    Extract<Awaited<ReturnType<FleetContainerRuntime["inspectNetwork"]>>, { kind: "ok" }>
  >();
  const inspectNetwork = vi.fn<FleetContainerRuntime["inspectNetwork"]>(
    async (_runtime, name) => networks.get(name) ?? { kind: "missing" },
  );
  const isDockerRootless = vi.fn<FleetContainerRuntime["isDockerRootless"]>(async () => false);
  const run = vi.fn<FleetContainerRuntime["run"]>(async (profile, start) => {
    removedContainers.delete(profile.containerName);
    inspections.set(
      profile.containerName,
      runningInspection({
        state: start ? "running" : "created",
        running: start,
        labels: fleetLabels(profile.tenantId, profile.attemptId),
        environment: { ...profile.environment },
        imageId: `sha256:${profile.attemptId}`,
        memory: profile.memory,
        cpus: profile.cpus,
        pidsLimit: profile.pidsLimit,
      }),
    );
  });
  const pull = vi.fn<FleetContainerRuntime["pull"]>(async () => undefined);
  const createNetwork = vi.fn<FleetContainerRuntime["createNetwork"]>(
    async (_runtime, name, labels, options) => {
      networks.set(name, {
        kind: "ok",
        labels: { ...labels },
        attachedContainers: [],
        internal: options.internal,
      });
    },
  );
  const removeNetwork = vi.fn<FleetContainerRuntime["removeNetwork"]>(async (_runtime, name) => {
    networks.delete(name);
  });
  const start = vi.fn<FleetContainerRuntime["start"]>(async (_runtime, name) => {
    const current = await inspect("docker", name);
    if (current.kind === "ok") {
      inspections.set(name, { ...current, state: "running", running: true });
    }
  });
  const stop = vi.fn<FleetContainerRuntime["stop"]>(async () => undefined);
  const restart = vi.fn<FleetContainerRuntime["restart"]>(async () => undefined);
  const logs = vi.fn<FleetContainerRuntime["logs"]>(async () => undefined);
  const remove = vi.fn<FleetContainerRuntime["remove"]>(async (_runtime, name) => {
    inspections.delete(name);
    removedContainers.add(name);
    inspect.mockResolvedValue({ kind: "missing", state: "missing" });
  });
  return {
    runtime: {
      assertLocal,
      inspect,
      inspectNetwork,
      isDockerRootless,
      run,
      pull,
      createNetwork,
      removeNetwork,
      start,
      stop,
      restart,
      logs,
      remove,
    },
    assertLocal,
    inspect,
    inspectNetwork,
    isDockerRootless,
    run,
    pull,
    createNetwork,
    removeNetwork,
    start,
    stop,
    restart,
    logs,
    remove,
  };
}

describe("fleet service", () => {
  let env: NodeJS.ProcessEnv;

  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-service-" });

  beforeEach(async () => {
    root = await tempRoot.setup();
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    );
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllGlobals();
    await tempRoot.cleanup();
  });

  it("creates a bootable token-only cell config and returns the secret-bearing result", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1_700_000_000_000,
      generateToken: () => "gw-token",
    });

    const result = await service.create({
      tenant: "acme",
      env: ["FEATURE=a=b"],
    });

    expect(result).toEqual({
      tenant: "acme",
      containerName: "openclaw-cell-acme",
      port: 19_100,
      image: "ghcr.io/openclaw/openclaw:latest",
      runtime: "docker",
      started: true,
      token: "gw-token",
      tokenNote: "Shown once. Store this Gateway token securely.",
      url: "http://127.0.0.1:19100",
      nextStep:
        "Open http://127.0.0.1:19100, then configure per-tenant channel accounts inside the cell.",
    });
    expect(containers.run).toHaveBeenCalledOnce();
    const [profile, start] = containers.run.mock.calls[0] ?? [];
    expect(start).toBe(false);
    expect(containers.createNetwork).toHaveBeenCalledWith(
      "docker",
      "openclaw-cell-acme-net",
      {
        "openclaw.fleet.tenant": "acme",
        "openclaw.fleet.owner": cellOwnerId(path.join(root, "fleet", "cells", "acme")),
        "openclaw.fleet.attempt": expect.stringMatching(/^[a-f0-9]{32}$/u),
      },
      { internal: false },
    );
    expect(containers.start).toHaveBeenCalledWith("docker", "openclaw-cell-acme");
    expect(profile?.networkName).toBe("openclaw-cell-acme-net");
    expect(containers.createNetwork.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
      containers.run.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(containers.run.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
      containers.start.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(profile?.environment).toMatchObject({
      OPENCLAW_GATEWAY_TOKEN: "gw-token",
      FEATURE: "a=b",
    });

    const dataDir = path.join(root, "fleet", "cells", "acme");
    const config = JSON.parse(await fs.readFile(path.join(dataDir, "openclaw.json"), "utf8")) as {
      gateway?: {
        mode?: string;
        bind?: string;
        auth?: Record<string, unknown>;
        controlUi?: { allowedOrigins?: string[] };
      };
    };
    expect(config.gateway).toMatchObject({
      mode: "local",
      bind: "lan",
      auth: { mode: "token" },
      controlUi: {
        allowedOrigins: ["http://localhost:19100", "http://127.0.0.1:19100"],
      },
    });
    expect(config.gateway?.auth).not.toHaveProperty("token");
    const authSecretDir = cellAuthSecretDir(root, "acme");
    await expect(fs.stat(authSecretDir)).resolves.toBeDefined();
    expect(path.relative(dataDir, authSecretDir)).toMatch(/^\.\./u);
  });

  it("generates a 32-character hexadecimal token", async () => {
    const containers = createContainerMock();
    const result = await createFleetService({ env, containers: containers.runtime }).create({
      tenant: "random-token",
      start: false,
    });

    expect(result.token).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("health-gates started creates and skips the gate with --no-start", async () => {
    const containers = createContainerMock();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      probePort: async () => true,
    });

    await expect(
      service.create({ tenant: "healthy", gatewayToken: "token" }),
    ).resolves.toMatchObject({ tenant: "healthy", started: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    await expect(
      service.create({ tenant: "stopped", gatewayToken: "token", start: false }),
    ).resolves.toMatchObject({ tenant: "stopped", started: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an unhealthy created cell and its runtime evidence", async () => {
    const containers = createContainerMock();
    let clock = 0;
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
      now: () => (clock += 50_000),
      sleep: async () => {},
      probePort: async () => true,
    });

    await expect(service.create({ tenant: "sick", gatewayToken: "token" })).rejects.toThrow(
      "Fleet cell sick was created but did not become healthy within 60s; inspect it with `openclaw fleet status sick` or `openclaw fleet logs sick`, or remove it with `openclaw fleet rm sick --force`.",
    );

    expect(getFleetCell(env, "sick")).toBeDefined();
    expect(containers.remove).not.toHaveBeenCalled();
    expect(containers.removeNetwork).not.toHaveBeenCalled();
  });

  it("rejects busy explicit ports before reservation and propagates probe errors", async () => {
    const containers = createContainerMock();
    const busy = createFleetService({
      env,
      containers: containers.runtime,
      probePort: async () => false,
    });
    await expect(
      busy.create({ tenant: "busy", port: 20_000, gatewayToken: "token" }),
    ).rejects.toThrow("Host port 20000 is already in use on 127.0.0.1 by another process.");
    expect(getFleetCell(env, "busy")).toBeUndefined();

    const failure = new Error("bind permission denied");
    const broken = createFleetService({
      env,
      containers: containers.runtime,
      probePort: async () => {
        throw failure;
      },
    });
    await expect(broken.create({ tenant: "broken", gatewayToken: "token" })).rejects.toBe(failure);
    expect(getFleetCell(env, "broken")).toBeUndefined();
  });

  it("skips probe-busy ports during automatic allocation", async () => {
    const containers = createContainerMock();
    const probePort = vi.fn(async (port: number) => port !== 19_100);
    const service = createFleetService({ env, containers: containers.runtime, probePort });

    const result = await service.create({ tenant: "acme", gatewayToken: "token" });

    expect(probePort.mock.calls.map(([port]) => port)).toEqual([19_100, 19_101]);
    expect(result.port).toBe(19_101);
    expect(getFleetCell(env, "acme")?.hostPort).toBe(19_101);
  });

  it("keeps scanning past long busy runs instead of capping attempts", async () => {
    const containers = createContainerMock();
    const probePort = vi.fn(async (port: number) => port >= 19_130);
    const service = createFleetService({ env, containers: containers.runtime, probePort });

    const result = await service.create({ tenant: "acme", gatewayToken: "token" });

    expect(result.port).toBe(19_130);
    expect(probePort).toHaveBeenCalledTimes(31);
  });

  it("retries automatic allocation when another tenant reserves the probed port", async () => {
    const containers = createContainerMock();
    let releaseFirstProbes: (() => void) | undefined;
    let firstProbeCount = 0;
    const firstProbes = new Promise<void>((resolve) => {
      releaseFirstProbes = resolve;
    });
    const probePort = vi.fn(async (port: number) => {
      if (port === 19_100 && (firstProbeCount += 1) < 2) {
        await firstProbes;
      } else if (port === 19_100) {
        releaseFirstProbes?.();
      }
      return true;
    });
    const service = createFleetService({ env, containers: containers.runtime, probePort });

    const [alpha, beta] = await Promise.all([
      service.create({ tenant: "alpha", gatewayToken: "alpha-token" }),
      service.create({ tenant: "beta", gatewayToken: "beta-token" }),
    ]);

    expect(new Set([alpha.port, beta.port])).toEqual(new Set([19_100, 19_101]));
    expect(
      listFleetCells(env)
        .map((cell) => cell.hostPort)
        .toSorted((left, right) => left - right),
    ).toEqual([19_100, 19_101]);
  });

  it("threads disk and Podman internal networking into provisioning", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      now: () => 1000,
    });
    await service.create({
      tenant: "acme",
      runtime: "podman",
      disk: "10g",
      network: "internal",
      gatewayToken: "token",
    });
    expect(containers.run.mock.calls[0]?.[0]).toMatchObject({ diskSize: "10g" });
    expect(containers.createNetwork).toHaveBeenCalledWith(
      "podman",
      "openclaw-cell-acme-net",
      expect.any(Object),
      { internal: true },
    );
  });

  it("rejects Docker internal networking before reservation", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime });
    await expect(
      service.create({ tenant: "acme", network: "internal", gatewayToken: "token" }),
    ).rejects.toThrow(/Docker cannot publish loopback ports/iu);
    expect(getFleetCell(env, "acme")).toBeUndefined();
    expect(containers.createNetwork).not.toHaveBeenCalled();
  });

  it("wraps unsupported disk errors after rolling back the reservation", async () => {
    const containers = createContainerMock();
    containers.run.mockRejectedValue(new Error("--storage-opt is supported only with pquota"));
    const service = createFleetService({ env, containers: containers.runtime });
    await expect(
      service.create({ tenant: "acme", disk: "10g", gatewayToken: "token" }),
    ).rejects.toThrow(/Fleet cannot enforce --disk.*XFS/iu);
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("rejects a remote runtime before registry or filesystem mutation", async () => {
    const containers = createContainerMock();
    containers.assertLocal.mockRejectedValue(
      new Error("Fleet requires a local Docker endpoint; remote cells are not supported."),
    );
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "remote", gatewayToken: "token" })).rejects.toThrow(
      /local Docker endpoint.*remote cells/iu,
    );

    expect(getFleetCell(env, "remote")).toBeUndefined();
    expect(containers.createNetwork).not.toHaveBeenCalled();
    expect(containers.run).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "fleet", "cells", "remote"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lists cells deterministically and degrades runtime failures to unknown", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "zulu", gatewayToken: "z-token" });
    await service.create({ tenant: "alpha", gatewayToken: "a-token" });
    containers.inspect.mockImplementation(async (_runtime, name) =>
      name.endsWith("alpha")
        ? runningInspection({ labels: fleetLabels("alpha") })
        : { kind: "unavailable", state: "unknown", error: "daemon unavailable" },
    );

    const cells = await service.list();

    expect(cells.map((cell) => [cell.tenant, cell.state])).toEqual([
      ["alpha", "running"],
      ["zulu", "unknown"],
    ]);
    expect(JSON.stringify(cells)).not.toContain("old-token");
  });

  it("reports live status with a bounded loopback health probe", async () => {
    const containers = createContainerMock();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      now: () => 1000,
    });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());

    const status = await service.status("acme");

    expect(status.container).toEqual({
      state: "running",
      running: true,
      managed: true,
      imageId: "sha256:old-image-id",
    });
    expect(status.health).toEqual({
      status: "ok",
      url: "http://127.0.0.1:19100/healthz",
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:19100/healthz",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(JSON.stringify(status)).not.toContain("old-token");
  });

  it("reports failed and skipped health outcomes without probing a stopped cell", async () => {
    const containers = createContainerMock();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      now: () => 1000,
    });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    fetchMock.mockClear();
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));

    await expect(service.status("acme")).resolves.toMatchObject({
      health: { status: "skipped", reason: "container is not running" },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    containers.inspect.mockResolvedValue(runningInspection());
    await expect(service.status("acme")).resolves.toMatchObject({
      health: { status: "failed", httpStatus: 503, error: "HTTP 503" },
    });
  });

  it("omits imageId for missing and unmanaged status", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });

    containers.inspect.mockResolvedValue(runningInspection({ labels: {} }));
    expect((await service.status("acme")).container).not.toHaveProperty("imageId");
    containers.inspect.mockResolvedValue({ kind: "missing", state: "missing" });
    expect((await service.status("acme")).container).not.toHaveProperty("imageId");
  });

  it.each(["start", "stop", "restart"] as const)("runs the %s lifecycle action", async (action) => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());
    containers[action].mockClear();

    await expect(service.lifecycle("acme", action)).resolves.toEqual({ tenant: "acme", action });

    expect(containers[action]).toHaveBeenCalledWith("docker", "openclaw-cell-acme");
  });

  it("streams logs only after proving container ownership", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());

    await expect(
      service.logs({ tenant: "acme", follow: true, tail: 100, since: "10m" }),
    ).resolves.toBeUndefined();

    expect(containers.logs).toHaveBeenCalledWith("docker", "openclaw-cell-acme", {
      follow: true,
      tail: 100,
      since: "10m",
      redactValues: ["old-token"],
    });
  });

  it.each(["foreign", "missing", "unavailable"] as const)(
    "refuses %s log inspection before streaming",
    async (kind) => {
      const inspection: FleetContainerInspectResult =
        kind === "foreign"
          ? runningInspection({ labels: {} })
          : kind === "missing"
            ? { kind: "missing", state: "missing" }
            : { kind: "unavailable", state: "unknown", error: "daemon unavailable" };
      const containers = createContainerMock();
      const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
      await service.create({ tenant: "acme", gatewayToken: "token" });
      containers.inspect.mockResolvedValue(inspection);

      await expect(service.logs({ tenant: "acme" })).rejects.toThrow();
      expect(containers.logs).not.toHaveBeenCalled();
    },
  );

  it("refuses logs when the recorded runtime is unavailable", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockClear();
    containers.assertLocal.mockRejectedValue(new Error("daemon unavailable"));

    await expect(service.logs({ tenant: "acme" })).rejects.toThrow(/daemon unavailable/iu);
    expect(containers.inspect).not.toHaveBeenCalled();
    expect(containers.logs).not.toHaveBeenCalled();
  });

  it("carries inspected environment and resources through upgrade", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    // The disk limit replays from the fleet label because Podman inspect has no
    // HostConfig.StorageOpt; the label is the cross-runtime carrier.
    const diskLabels = { ...fleetLabels(), "openclaw.fleet.disk-limit": "10g" };
    containers.inspect
      .mockResolvedValue(runningInspection({ labels: diskLabels }))
      .mockResolvedValueOnce(runningInspection({ labels: diskLabels }))
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }));

    const result = await service.upgrade("acme", "ghcr.io/openclaw/openclaw:v2");

    expect(result).toEqual({
      tenant: "acme",
      action: "upgrade",
      image: "ghcr.io/openclaw/openclaw:v2",
    });
    expect(containers.pull).toHaveBeenCalledWith("docker", "ghcr.io/openclaw/openclaw:v2");
    expect(containers.stop).toHaveBeenCalledWith("docker", "openclaw-cell-acme");
    expect(containers.remove).toHaveBeenCalledWith("docker", "openclaw-cell-acme", false);
    expect(containers.inspectNetwork).toHaveBeenCalledWith("docker", "openclaw-cell-acme-net");
    const [profile, start] = containers.run.mock.calls[0] ?? [];
    expect(start).toBe(true);
    expect(profile).toMatchObject({
      image: "ghcr.io/openclaw/openclaw:v2",
      hostPort: 19_100,
      memory: "2147483648",
      cpus: "2",
      pidsLimit: 512,
      diskSize: "10g",
      networkName: "openclaw-cell-acme-net",
      environment: {
        HOME: "/home/node",
        OPENCLAW_GATEWAY_TOKEN: "old-token",
        FEATURE: "enabled",
      },
    });
    expect(profile?.environment).not.toHaveProperty("NODE_VERSION");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:v2");
  });

  it("passes digest-pinned images verbatim to create and upgrade", async () => {
    const containers = createContainerMock();
    const digest = `ghcr.io/openclaw/openclaw@sha256:${"a".repeat(64)}`;
    const service = createFleetService({
      env,
      containers: containers.runtime,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });

    await service.create({ tenant: "acme", image: digest, gatewayToken: "old-token" });
    expect(containers.run.mock.calls[0]?.[0].image).toBe(digest);

    containers.run.mockClear();
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }));
    await service.upgrade("acme");

    expect(containers.pull).toHaveBeenCalledWith("docker", digest);
    expect(containers.run.mock.calls[0]?.[0].image).toBe(digest);
  });

  it("restores the immutable old image when replacement fails", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce({ kind: "missing", state: "missing" });
    containers.run.mockRejectedValueOnce(new Error("replacement failed")).mockResolvedValueOnce();

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restarts the old cell when removal fails after stop", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    containers.start.mockClear();
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(runningInspection({ state: "exited", running: false }));
    containers.remove.mockRejectedValueOnce(new Error("daemon busy"));

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.stop).toHaveBeenCalledWith("docker", "openclaw-cell-acme");
    expect(containers.start).toHaveBeenCalledWith("docker", "openclaw-cell-acme");
    expect(containers.run).not.toHaveBeenCalled();
  });

  it("restores the old cell when the replacement registry update fails", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
      updateImage: () => {
        throw new Error("state database is full");
      },
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    containers.remove.mockClear();
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }))
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }));

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(containers.remove).toHaveBeenCalledWith("docker", "openclaw-cell-acme", true);
    expect(containers.removeNetwork).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restores the previous cell when the replacement container is not running", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    const crashLooping = runningInspection({
      labels: fleetLabels("acme", NEXT_ATTEMPT_ID),
      state: "restarting",
      running: false,
    });
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(crashLooping)
      .mockResolvedValueOnce(crashLooping);

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restores the previous cell when the replacement crashes after starting", async () => {
    const containers = createContainerMock();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValue(new Error("connect ECONNREFUSED"));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      sleep: async () => {},
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    const crashed = runningInspection({
      labels: fleetLabels("acme", NEXT_ATTEMPT_ID),
      state: "exited",
      running: false,
    });
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }))
      .mockResolvedValueOnce(crashed)
      .mockResolvedValueOnce(crashed);

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restores the previous cell when the replacement never becomes healthy", async () => {
    const containers = createContainerMock();
    let clock = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      sleep: async () => {},
      now: () => (clock += 50_000),
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    const hung = runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) });
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(hung)
      .mockResolvedValueOnce(hung)
      .mockResolvedValueOnce(hung);

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("refuses upgrade before pull or removal when the inspected token is missing", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.inspect.mockResolvedValue(
      runningInspection({ environment: { HOME: "/home/node" } }),
    );

    await expect(service.upgrade("acme")).rejects.toThrow(/no Gateway token environment/iu);
    expect(containers.pull).not.toHaveBeenCalled();
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("refuses upgrade when an unexpected container is attached to the cell network", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.inspect.mockResolvedValue(runningInspection());
    containers.inspectNetwork.mockResolvedValue({
      kind: "ok",
      labels: fleetLabels(),
      attachedContainers: [
        { id: "cell-id", name: "openclaw-cell-acme" },
        { id: "peer-id", name: "unexpected-peer" },
      ],
      internal: false,
    });

    await expect(service.upgrade("acme")).rejects.toThrow(/unexpected containers/iu);
    expect(containers.pull).toHaveBeenCalledOnce();
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("rejects option-like images before create or upgrade mutations", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(
      service.create({ tenant: "bad-image", image: "--help", gatewayToken: "token" }),
    ).rejects.toThrow(/image must not begin/iu);
    expect(getFleetCell(env, "bad-image")).toBeUndefined();
    expect(containers.run).not.toHaveBeenCalled();

    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());
    await expect(service.upgrade("acme", "--help")).rejects.toThrow(/image must not begin/iu);
    expect(containers.pull).not.toHaveBeenCalled();
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("requires force for running removal and purge", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());

    await expect(service.remove({ tenant: "acme" })).rejects.toThrow(/running.*--force/iu);
    await expect(service.remove({ tenant: "acme", purgeData: true })).rejects.toThrow(
      "--purge-data requires --force.",
    );
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("removes a labeled partial container before releasing a failed create", async () => {
    const containers = createContainerMock(runningInspection());
    containers.run.mockRejectedValue(new Error("host port is already allocated"));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already allocated/iu,
    );

    expect(containers.remove).toHaveBeenCalledWith("docker", "openclaw-cell-acme", true);
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("retains a failed-create reservation when partial cleanup is uncertain", async () => {
    const containers = createContainerMock({
      kind: "unavailable",
      state: "unknown",
      error: "daemon unavailable",
    });
    containers.run.mockRejectedValue(new Error("container command timed out"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /timed out/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeDefined();
  });

  it("cleans up its exact-attempt network when network creation fails", async () => {
    const containers = createContainerMock();
    containers.createNetwork.mockRejectedValue(new Error("network create timed out"));
    containers.inspectNetwork
      .mockResolvedValueOnce({
        kind: "ok",
        labels: fleetLabels(),
        attachedContainers: [],
        internal: false,
      })
      .mockResolvedValueOnce({ kind: "missing" });
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /timed out/iu,
    );

    expect(containers.run).not.toHaveBeenCalled();
    expect(containers.removeNetwork).toHaveBeenCalledWith("docker", "openclaw-cell-acme-net");
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("serializes same-tenant mutations across service instances", async () => {
    const containers = createContainerMock();
    let releaseNetwork: (() => void) | undefined;
    containers.createNetwork.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          releaseNetwork = resolve;
        }),
    );
    const first = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    const second = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    const creating = first.create({ tenant: "acme", gatewayToken: "token" });
    await vi.waitFor(() => expect(containers.createNetwork).toHaveBeenCalledOnce());
    await expect(second.create({ tenant: "acme", gatewayToken: "other-token" })).rejects.toThrow(
      /fleet create.*already running/iu,
    );

    releaseNetwork?.();
    await expect(creating).resolves.toMatchObject({ tenant: "acme" });
  });

  it("releases a failed operation lease for a retry", async () => {
    const containers = createContainerMock();
    containers.createNetwork.mockRejectedValueOnce(new Error("daemon busy"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /daemon busy/iu,
    );
    await expect(
      service.create({ tenant: "acme", gatewayToken: "retry-token" }),
    ).resolves.toMatchObject({ tenant: "acme" });
  });

  it("removes its exact-attempt container when the reservation disappears mid-create", async () => {
    const containers = createContainerMock(runningInspection({ state: "created", running: false }));
    containers.run.mockImplementation(async () => {
      deleteFleetCell(env, "acme");
    });
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /reservation changed/iu,
    );

    expect(containers.remove).toHaveBeenCalledWith("docker", "openclaw-cell-acme", true);
    expect(containers.start).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("releases the reservation when an unlabeled foreign container holds the cell name", async () => {
    const containers = createContainerMock(runningInspection({ labels: {} }));
    containers.run.mockRejectedValue(new Error("container name is already in use"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("releases the reservation when an unlabeled foreign network holds the cell name", async () => {
    const containers = createContainerMock();
    containers.createNetwork.mockRejectedValue(new Error("network name is already in use"));
    containers.inspectNetwork.mockResolvedValue({
      kind: "ok",
      labels: {},
      attachedContainers: [],
      internal: false,
    });
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.removeNetwork).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("never removes a same-tenant container owned by another profile", async () => {
    const containers = createContainerMock(
      runningInspection({
        labels: {
          ...fleetLabels(),
          "openclaw.fleet.owner": "11111111111111111111111111111111",
        },
      }),
    );
    containers.run.mockRejectedValue(new Error("container name is already in use"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("never removes a same-profile container that predates the create attempt", async () => {
    const containers = createContainerMock(
      runningInspection({
        labels: fleetLabels("acme", "33333333333333333333333333333333"),
      }),
    );
    containers.run.mockRejectedValue(new Error("container name is already in use"));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeDefined();
  });
});
