import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { cellAuthSecretDir, cellOwnerId } from "./cell-profile.js";
import type { FleetContainerInspectResult, FleetContainerRuntime } from "./containers.runtime.js";
import { getFleetCell, reserveFleetCell } from "./registry.js";
import {
  createFleetService as createFleetServiceRuntime,
  type FleetServiceOptions,
} from "./service.runtime.js";

let root: string;
const TEST_ATTEMPT_ID = "22222222222222222222222222222222";

function createFleetService(options: FleetServiceOptions = {}) {
  return createFleetServiceRuntime({
    fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    probePort: async () => true,
    ...options,
  });
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
    containerId: "container-id",
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
        containerId: `container-${profile.attemptId}`,
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

describe("fleet service filesystem and removal", () => {
  let env: NodeJS.ProcessEnv;

  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-service-" });

  beforeEach(async () => {
    root = await tempRoot.setup();
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await tempRoot.cleanup();
  });

  it("maps rootless users and SELinux mounts for Docker and Podman", async () => {
    const docker = createContainerMock();
    docker.isDockerRootless.mockResolvedValue(true);
    await createFleetService({
      env,
      containers: docker.runtime,
      getuid: () => 1001,
      getgid: () => 1002,
      selinuxEnabled: async () => true,
    }).create({ tenant: "docker-cell", gatewayToken: "token" });
    expect(docker.run.mock.calls[0]?.[0].containerUser).toEqual({
      mode: "numeric",
      uid: 0,
      gid: 0,
    });
    expect(docker.run.mock.calls[0]?.[0].selinuxRelabel).toBe(true);

    const podman = createContainerMock();
    await createFleetService({
      env,
      containers: podman.runtime,
      getuid: () => 1001,
      getgid: () => 1002,
      selinuxEnabled: async () => true,
    }).create({ tenant: "podman-cell", runtime: "podman", gatewayToken: "token" });
    expect(podman.isDockerRootless).not.toHaveBeenCalled();
    expect(podman.run.mock.calls[0]?.[0]).toMatchObject({
      containerUser: { mode: "podman-keep-id", uid: 1001, gid: 1002 },
      selinuxRelabel: true,
    });
  });

  it("refuses a realpath escape before container or registry removal", async () => {
    const containers = createContainerMock();
    const cellsRoot = path.join(root, "fleet", "cells");
    const outside = path.join(root, "outside-cell");
    await fs.mkdir(cellsRoot, { recursive: true });
    await fs.mkdir(outside);
    reserveFleetCell(env, {
      tenantId: "escape",
      createdAtMs: 1000,
      image: "ghcr.io/openclaw/openclaw:latest",
      runtime: "docker",
      containerName: "openclaw-cell-escape",
      dataDir: outside,
    });
    const service = createFleetService({ env, containers: containers.runtime });

    await expect(
      service.remove({ tenant: "escape", purgeData: true, force: true }),
    ).rejects.toThrow(/outside its fleet-owned directory/iu);
    expect(containers.inspect).not.toHaveBeenCalled();
    expect(getFleetCell(env, "escape")).toBeDefined();
    await expect(fs.stat(outside)).resolves.toBeDefined();
  });

  it("refuses to purge a tenant symlinked to a sibling cell", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    await service.create({ tenant: "beta", gatewayToken: "token" });
    const acmeDir = path.join(root, "fleet", "cells", "acme");
    const betaDir = path.join(root, "fleet", "cells", "beta");
    await fs.rm(acmeDir, { recursive: true });
    await fs.symlink(betaDir, acmeDir, "dir");
    containers.inspect.mockClear();

    await expect(service.remove({ tenant: "acme", purgeData: true, force: true })).rejects.toThrow(
      /symlinked fleet tenant directory/iu,
    );

    expect(containers.inspect).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(betaDir, "openclaw.json"))).resolves.toBeDefined();
    expect(getFleetCell(env, "acme")).toBeDefined();
  });

  it("refuses a tenant-controlled config symlink during recreate", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    await service.create({ tenant: "beta", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));
    await service.remove({ tenant: "acme" });
    const acmeConfig = path.join(root, "fleet", "cells", "acme", "openclaw.json");
    const betaConfig = path.join(root, "fleet", "cells", "beta", "openclaw.json");
    const betaBefore = await fs.readFile(betaConfig, "utf8");
    await fs.rm(acmeConfig);
    await fs.symlink("../beta/openclaw.json", acmeConfig);
    const runCount = containers.run.mock.calls.length;
    containers.inspect.mockResolvedValue(runningInspection({ state: "created", running: false }));
    const retryService = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(retryService.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /unsafe cell config/iu,
    );

    expect(containers.run).toHaveBeenCalledTimes(runCount + 1);
    expect(containers.remove).toHaveBeenCalledWith("docker", "openclaw-cell-acme", true);
    expect(getFleetCell(env, "acme")).toBeUndefined();
    await expect(fs.readFile(betaConfig, "utf8")).resolves.toBe(betaBefore);
  });

  it("validates rejected recreate input before rewriting retained config", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));
    await service.remove({ tenant: "acme" });
    const configPath = path.join(root, "fleet", "cells", "acme", "openclaw.json");
    const configBefore = await fs.readFile(configPath, "utf8");
    const runCount = containers.run.mock.calls.length;

    await expect(
      service.create({ tenant: "acme", gatewayToken: "token", env: ["INVALID"] }),
    ).rejects.toThrow(/expected KEY=VAL/iu);

    expect(containers.run).toHaveBeenCalledTimes(runCount);
    expect(getFleetCell(env, "acme")).toBeUndefined();
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(configBefore);
  });

  it("purges a contained cell only after forced container removal", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());

    await expect(service.remove({ tenant: "acme", purgeData: true, force: true })).resolves.toEqual(
      { tenant: "acme", action: "rm", dataPurged: true },
    );

    expect(containers.remove).toHaveBeenCalledWith("docker", "openclaw-cell-acme", true);
    expect(containers.removeNetwork).toHaveBeenCalledWith("docker", "openclaw-cell-acme-net");
    expect(getFleetCell(env, "acme")).toBeUndefined();
    await expect(fs.stat(path.join(root, "fleet", "cells", "acme"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(cellAuthSecretDir(root, "acme"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("passes explicit force through even when inspect observed a stopped container", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));

    await service.remove({ tenant: "acme", force: true });

    expect(containers.remove).toHaveBeenCalledWith("docker", "openclaw-cell-acme", true);
  });

  it("retains state when network removal fails and completes on retry", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));
    containers.removeNetwork.mockRejectedValueOnce(new Error("network still in use"));

    await expect(service.remove({ tenant: "acme", purgeData: true, force: true })).rejects.toThrow(
      /still in use/iu,
    );
    expect(getFleetCell(env, "acme")).toBeDefined();
    await expect(fs.stat(path.join(root, "fleet", "cells", "acme"))).resolves.toBeDefined();

    await expect(
      service.remove({ tenant: "acme", purgeData: true, force: true }),
    ).resolves.toMatchObject({ tenant: "acme", dataPurged: true });
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("finishes purge when one exact tenant directory is already missing", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    await fs.rm(path.join(root, "fleet", "cells", "acme"), { recursive: true });

    await expect(service.remove({ tenant: "acme", purgeData: true, force: true })).resolves.toEqual(
      { tenant: "acme", action: "rm", dataPurged: true },
    );

    expect(getFleetCell(env, "acme")).toBeUndefined();
    await expect(fs.stat(cellAuthSecretDir(root, "acme"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to remove a container when its cell network belongs to another profile", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));
    containers.inspectNetwork.mockResolvedValue({
      kind: "ok",
      labels: {
        ...fleetLabels(),
        "openclaw.fleet.owner": "11111111111111111111111111111111",
      },
      attachedContainers: [],
      internal: false,
    });
    containers.remove.mockClear();

    await expect(service.remove({ tenant: "acme" })).rejects.toThrow(
      /acme-net.*ownership labels/iu,
    );
    expect(containers.remove).not.toHaveBeenCalled();
    expect(containers.removeNetwork).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeDefined();
  });

  it("refuses removal before mutation when an unexpected network peer is attached", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));
    containers.inspectNetwork.mockResolvedValue({
      kind: "ok",
      labels: fleetLabels(),
      attachedContainers: [{ id: "peer-id", name: "unexpected-peer" }],
      internal: false,
    });
    containers.remove.mockClear();

    await expect(service.remove({ tenant: "acme" })).rejects.toThrow(/unexpected containers/iu);
    expect(containers.remove).not.toHaveBeenCalled();
    expect(containers.removeNetwork).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeDefined();
  });
});
