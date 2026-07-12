import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { cellAuthSecretDir, cellOwnerId } from "./cell-profile.js";
import type {
  FleetContainerInspectResult,
  FleetContainerRuntime,
  FleetNetworkInspectResult,
} from "./containers.runtime.js";
import { runFleetDoctor } from "./doctor.runtime.js";
import { deleteFleetCell, reserveFleetCell, type FleetCellRecord } from "./registry.js";

let root: string;
let env: NodeJS.ProcessEnv;
let record: FleetCellRecord;
const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-doctor-" });

function healthyInspection(): Extract<FleetContainerInspectResult, { kind: "ok" }> {
  return {
    kind: "ok",
    state: "running",
    running: true,
    labels: {
      "openclaw.fleet.tenant": "acme",
      "openclaw.fleet.owner": cellOwnerId(record.dataDir),
    },
    environment: { OPENCLAW_GATEWAY_TOKEN: "secret" },
    imageId: "sha256:image",
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
  };
}

function healthyNetwork(): Extract<FleetNetworkInspectResult, { kind: "ok" }> {
  return {
    kind: "ok",
    labels: {
      "openclaw.fleet.tenant": "acme",
      "openclaw.fleet.owner": cellOwnerId(record.dataDir),
    },
    attachedContainers: [{ id: "cell", name: "openclaw-cell-acme" }],
    internal: false,
  };
}

function runtimeMock(
  inspection = healthyInspection(),
  network = healthyNetwork(),
): FleetContainerRuntime {
  return {
    assertLocal: vi.fn(async () => undefined),
    inspect: vi.fn(async () => inspection),
    inspectNetwork: vi.fn(async () => network),
    isDockerRootless: vi.fn(async () => false),
    run: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    createNetwork: vi.fn(async () => undefined),
    removeNetwork: vi.fn(async () => undefined),
    logs: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
}

beforeEach(async () => {
  root = await tempRoot.setup();
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
  record = reserveFleetCell(env, {
    tenantId: "acme",
    createdAtMs: 0,
    image: "image",
    runtime: "docker",
    containerName: "openclaw-cell-acme",
    dataDir: path.join(root, "fleet", "cells", "acme"),
  });
  await fs.mkdir(record.dataDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(cellAuthSecretDir(root, "acme"), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempRoot.cleanup();
});

describe("fleet doctor", () => {
  it.each(["docker", "podman"] as const)(
    "reports a healthy %s cell as all pass",
    async (runtime) => {
      if (runtime !== record.runtime) {
        deleteFleetCell(env, "acme");
        record = reserveFleetCell(env, {
          tenantId: "acme",
          createdAtMs: 0,
          image: "image",
          runtime,
          containerName: "openclaw-cell-acme",
          dataDir: path.join(root, "fleet", "cells", "acme"),
        });
      }
      const inspection = healthyInspection();
      const network = healthyNetwork();
      if (runtime === "podman") {
        // Podman expands --cap-drop=ALL into individual caps, reports the empty
        // effective set via top-level EffectiveCaps, and omits the network
        // containers map entirely (all verified live on netavark).
        inspection.capDrop = ["CAP_CHOWN", "CAP_KILL", "CAP_SETUID"];
        inspection.effectiveCaps = [];
        network.attachedContainers = [];
      }
      const reports = await runFleetDoctor({
        env,
        containers: runtimeMock(inspection, network),
        fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      });
      expect(reports).toHaveLength(1);
      expect(reports[0]?.findings.every((entry) => entry.status === "pass")).toBe(true);
    },
  );

  it("fails cap-drop when a Podman cell retains effective capabilities", async () => {
    deleteFleetCell(env, "acme");
    record = reserveFleetCell(env, {
      tenantId: "acme",
      createdAtMs: 0,
      image: "image",
      runtime: "podman",
      containerName: "openclaw-cell-acme",
      dataDir: path.join(root, "fleet", "cells", "acme"),
    });
    const inspection = healthyInspection();
    inspection.capDrop = ["CAP_KILL"];
    inspection.effectiveCaps = ["CAP_CHOWN"];
    const reports = await runFleetDoctor({
      env,
      containers: runtimeMock(inspection),
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    });
    expect(reports[0]?.findings).toContainEqual(
      expect.objectContaining({ check: "cap-drop", status: "fail" }),
    );
  });

  it.each([
    [
      "cap-drop",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.capDrop = [];
      },
    ],
    [
      "security-opt",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.securityOpt = [];
      },
    ],
    [
      "restart-policy",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.restartPolicy = "always";
      },
    ],
    [
      "port-binding",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.portBindings[0] = {
          containerPort: "18789/tcp",
          hostIp: "127.0.0.1",
          hostPort: "19101",
        };
      },
    ],
    [
      "port-binding",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.portBindings[0] = {
          containerPort: "18789/tcp",
          hostIp: "0.0.0.0",
          hostPort: "19100",
        };
      },
    ],
    [
      "container-owned",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.labels["openclaw.fleet.owner"] = "foreign";
      },
    ],
    [
      "gateway-token-env",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.environment.OPENCLAW_GATEWAY_TOKEN = "";
      },
    ],
    [
      "disk-limit",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        // Docker cell whose disk-limit label survives but whose applied
        // storage option was dropped out-of-band.
        inspection.labels["openclaw.fleet.disk-limit"] = "10g";
        inspection.storageOpt = {};
      },
    ],
    [
      "disk-limit",
      "fail",
      (inspection: ReturnType<typeof healthyInspection>) => {
        // Malformed label would break upgrade/restore replay on any runtime.
        inspection.labels["openclaw.fleet.disk-limit"] = "not-a-size";
        inspection.storageOpt = { size: "not-a-size" };
      },
    ],
    [
      "container-running",
      "warn",
      (inspection: ReturnType<typeof healthyInspection>) => {
        inspection.running = false;
        inspection.state = "exited";
      },
    ],
  ] as const)("reports %s drift as %s", async (check, status, mutate) => {
    const inspection = healthyInspection();
    mutate(inspection);
    const reports = await runFleetDoctor({
      env,
      containers: runtimeMock(inspection),
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    });
    expect(reports[0]?.findings).toContainEqual(expect.objectContaining({ check, status }));
  });

  it("reports filesystem and Docker internal-network drift", async () => {
    await fs.chmod(record.dataDir, 0o755);
    const authDir = cellAuthSecretDir(root, "acme");
    await fs.rm(authDir, { recursive: true });
    await fs.symlink(root, authDir);
    const network = healthyNetwork();
    network.internal = true;
    const reports = await runFleetDoctor({
      env,
      containers: runtimeMock(healthyInspection(), network),
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    });
    expect(reports[0]?.findings).toContainEqual(
      expect.objectContaining({
        check: "data-dir",
        status: "fail",
        detail: expect.stringContaining("0755"),
      }),
    );
    expect(reports[0]?.findings).toContainEqual(
      expect.objectContaining({ check: "auth-dir", status: "fail" }),
    );
    expect(reports[0]?.findings).toContainEqual(
      expect.objectContaining({ check: "network-egress", status: "fail" }),
    );
  });

  it("fails when Docker reports the running cell missing from its network", async () => {
    const network = healthyNetwork();
    network.attachedContainers = [];
    const reports = await runFleetDoctor({
      env,
      containers: runtimeMock(healthyInspection(), network),
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    });
    expect(reports[0]?.findings).toContainEqual(
      expect.objectContaining({
        check: "network-attachments",
        status: "fail",
        detail: expect.stringContaining("not attached"),
      }),
    );
  });

  it("accepts no active network attachment for a stopped cell", async () => {
    const stopped = healthyInspection();
    stopped.running = false;
    stopped.state = "exited";
    const network = healthyNetwork();
    network.attachedContainers = [];
    const reports = await runFleetDoctor({
      env,
      containers: runtimeMock(stopped, network),
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    });
    expect(reports[0]?.findings).toContainEqual(
      expect.objectContaining({ check: "network-attachments", status: "pass" }),
    );
    expect(reports[0]?.findings.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
