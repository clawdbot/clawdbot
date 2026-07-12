import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateHostPort,
  buildCellCreateArgs,
  buildCellEnvironment,
  buildCellRunArgs,
  cellAuthSecretDir,
  cellContainerName,
  cellDataDir,
  cellNetworkName,
  cellOwnerId,
  DEFAULT_FLEET_IMAGE,
  FLEET_BASE_PORT,
  FLEET_ATTEMPT_LABEL,
  FLEET_CONTAINER_AUTH_SECRET_DIR,
  FLEET_CONTAINER_STATE_DIR,
  FLEET_ENV_KEYS_LABEL,
  FLEET_GATEWAY_PORT,
  FLEET_OWNER_LABEL,
  FLEET_TENANT_LABEL,
  parseEnvAssignments,
  type CellContainerProfile,
  validateFleetImage,
  validateDiskSize,
  validateTenantId,
} from "./cell-profile.js";

const TEST_ENVIRONMENT_FILE = "/tmp/openclaw-fleet-env/cell.env";

function makeProfile(overrides: Partial<CellContainerProfile> = {}): CellContainerProfile {
  const tenantId = overrides.tenantId ?? "acme";
  const dataDir = overrides.dataDir ?? "/tmp/openclaw/fleet/cells/acme";
  return {
    tenantId,
    containerName: overrides.containerName ?? cellContainerName(tenantId),
    networkName: overrides.networkName ?? cellNetworkName(tenantId),
    image: DEFAULT_FLEET_IMAGE,
    runtime: "docker",
    hostPort: FLEET_BASE_PORT,
    dataDir,
    authSecretDir: overrides.authSecretDir ?? "/tmp/openclaw/fleet/auth-profile-secrets/acme",
    ownerId: overrides.ownerId ?? cellOwnerId(dataDir),
    attemptId: overrides.attemptId ?? "11111111111111111111111111111111",
    memory: "2g",
    cpus: "2",
    pidsLimit: 512,
    environment: buildCellEnvironment("gateway-token", { TENANT_REGION: "west=1" }),
    selinuxRelabel: false,
    ...overrides,
  };
}

function expectOption(args: string[], flag: string, value: string): void {
  const index = args.indexOf(flag);
  expect(index, `${flag} should be present`).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBe(value);
}

describe("fleet tenant ids", () => {
  it.each(["a", "0", "acme", "acme-2", "a--b", "a".repeat(40)])("accepts %s", (tenantId) => {
    expect(validateTenantId(tenantId)).toBe(tenantId);
  });

  it.each([
    "",
    ".",
    "..",
    "../acme",
    "acme/other",
    "acme\\other",
    "-acme",
    "acme-",
    "Acme",
    "acme_team",
    "acme team",
    "ténant",
    "a".repeat(41),
  ])("rejects %j", (tenantId) => {
    expect(() => validateTenantId(tenantId)).toThrow(/tenant id/i);
  });

  it("derives stable container and data paths", () => {
    expect(cellContainerName("acme-2")).toBe("openclaw-cell-acme-2");
    expect(cellNetworkName("acme-2")).toBe("openclaw-cell-acme-2-net");
    expect(cellDataDir("/srv/openclaw", "acme-2")).toBe(
      path.join("/srv/openclaw", "fleet", "cells", "acme-2"),
    );
    expect(cellAuthSecretDir("/srv/openclaw", "acme-2")).toBe(
      path.join("/srv/openclaw", "fleet", "auth-profile-secrets", "acme-2"),
    );
  });
});

describe("fleet port allocation", () => {
  it("starts at the fleet base port and scans gaps", () => {
    expect(allocateHostPort([])).toBe(FLEET_BASE_PORT);
    expect(allocateHostPort([FLEET_BASE_PORT, FLEET_BASE_PORT + 2])).toBe(FLEET_BASE_PORT + 1);
  });

  it("honors an explicit free TCP port", () => {
    expect(allocateHostPort([FLEET_BASE_PORT], 8080)).toBe(8080);
  });

  it("rejects explicit collisions and invalid ports", () => {
    expect(() => allocateHostPort([20_000], 20_000)).toThrow(/already allocated/i);
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => allocateHostPort([], port)).toThrow(/1 to 65535/i);
    }
  });
});

describe("fleet image references", () => {
  it("normalizes valid references and rejects option-like values", () => {
    expect(validateFleetImage(" ghcr.io/openclaw/openclaw:v1 ")).toBe(
      "ghcr.io/openclaw/openclaw:v1",
    );
    expect(() => validateFleetImage("--help")).toThrow(/must not begin/iu);
    expect(() => validateFleetImage(" ")).toThrow(/must not be empty/iu);
  });
});

describe("fleet disk limits", () => {
  it.each(["10g", "512m", "1.5g", "10GB", "1024", "2tb"])("accepts %s", (value) => {
    expect(validateDiskSize(value)).toBe(value);
  });

  it.each(["", " ", "0", "0g", "0.0GB", "-1g", "10 g", "g", "10g;x", "--size", "1e9"])(
    "rejects %j",
    (value) => {
      expect(() => validateDiskSize(value)).toThrow(/--disk/iu);
    },
  );

  it("adds storage-opt and the replay label only when configured", () => {
    const withDisk = buildCellRunArgs(makeProfile({ diskSize: "10g" }), {
      environmentFile: TEST_ENVIRONMENT_FILE,
    });
    const withoutDisk = buildCellRunArgs(makeProfile(), { environmentFile: TEST_ENVIRONMENT_FILE });
    expectOption(withDisk, "--storage-opt", "size=10g");
    expect(withDisk.indexOf("--storage-opt")).toBe(withDisk.indexOf("--cpus") + 2);
    expect(withDisk).toContain("openclaw.fleet.disk-limit=10g");
    expect(withoutDisk).not.toContain("--storage-opt");
    expect(withoutDisk.join(" ")).not.toContain("openclaw.fleet.disk-limit");
  });
});

describe("fleet cell environment", () => {
  it("parses KEY=VAL assignments without truncating values", () => {
    expect(parseEnvAssignments(["REGION=west", "URL=https://example.test/?a=b", "EMPTY="])).toEqual(
      {
        REGION: "west",
        URL: "https://example.test/?a=b",
        EMPTY: "",
      },
    );
    expect(parseEnvAssignments(["REGION=west", "REGION=east"])).toEqual({ REGION: "east" });
  });

  it.each(["MISSING", "=value", "BAD-KEY=value", "1BAD=value", "HAS SPACE=value"])(
    "rejects malformed assignment %j",
    (assignment) => {
      expect(() => parseEnvAssignments([assignment])).toThrow(/--env/i);
    },
  );

  it.each([
    "HOME",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_WORKSPACE_DIR",
    "OPENCLAW_GATEWAY_TOKEN",
  ])("rejects reserved variable %s", (key) => {
    expect(() => parseEnvAssignments([`${key}=override`])).toThrow(/fleet-managed/i);
  });

  it("pins the documented container paths and token", () => {
    expect(buildCellEnvironment("secret", { REGION: "west" })).toEqual({
      HOME: "/home/node",
      OPENCLAW_HOME: "/home/node",
      OPENCLAW_STATE_DIR: FLEET_CONTAINER_STATE_DIR,
      OPENCLAW_CONFIG_PATH: `${FLEET_CONTAINER_STATE_DIR}/openclaw.json`,
      OPENCLAW_WORKSPACE_DIR: `${FLEET_CONTAINER_STATE_DIR}/workspace`,
      OPENCLAW_GATEWAY_TOKEN: "secret",
      REGION: "west",
    });
  });

  it("rejects values that cannot be represented in the protected environment file", () => {
    expect(() => buildCellEnvironment("bad\ntoken", {})).toThrow(/line breaks/iu);
    expect(() => buildCellEnvironment("token", { FEATURE: "line\nbreak" })).toThrow(
      /must be one line/iu,
    );
  });
});

describe("fleet container arguments", () => {
  it("builds the complete hardened run profile", () => {
    const profile = makeProfile();
    const args = buildCellRunArgs(profile, { environmentFile: TEST_ENVIRONMENT_FILE });

    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expectOption(args, "--name", "openclaw-cell-acme");
    expectOption(args, "--label", `${FLEET_TENANT_LABEL}=acme`);
    expect(args).toContain(`${FLEET_OWNER_LABEL}=${cellOwnerId(profile.dataDir)}`);
    expect(args).toContain(`${FLEET_ATTEMPT_LABEL}=${profile.attemptId}`);
    expect(args).toContain(`${FLEET_ENV_KEYS_LABEL}=TENANT_REGION`);
    expect(args).toContain("--init");
    expect(args).toContain("--cap-drop=ALL");
    expectOption(args, "--security-opt", "no-new-privileges");
    expectOption(args, "--pids-limit", "512");
    expectOption(args, "--memory", "2g");
    expectOption(args, "--cpus", "2");
    expectOption(args, "--restart", "unless-stopped");
    expectOption(args, "--network", "openclaw-cell-acme-net");
    expectOption(args, "-p", `127.0.0.1:${FLEET_BASE_PORT}:${FLEET_GATEWAY_PORT}`);
    expect(args).toContain(`${profile.dataDir}:${FLEET_CONTAINER_STATE_DIR}`);
    expect(args).toContain(`${profile.authSecretDir}:${FLEET_CONTAINER_AUTH_SECRET_DIR}`);
    expectOption(args, "--env-file", TEST_ENVIRONMENT_FILE);
    expect(args.join(" ")).not.toContain("gateway-token");
    expect(args.join(" ")).not.toContain("west=1");
    expect(args.slice(-8)).toEqual([
      DEFAULT_FLEET_IMAGE,
      "node",
      "dist/index.js",
      "gateway",
      "--bind",
      "lan",
      "--port",
      String(FLEET_GATEWAY_PORT),
    ]);
  });

  it("builds a stopped container with the same profile", () => {
    const args = buildCellCreateArgs(makeProfile(), {
      environmentFile: TEST_ENVIRONMENT_FILE,
    });
    expect(args[0]).toBe("create");
    expect(args).not.toContain("-d");
    expect(args).toContain("--cap-drop=ALL");
    expect(args.slice(-7)).toEqual([
      "node",
      "dist/index.js",
      "gateway",
      "--bind",
      "lan",
      "--port",
      String(FLEET_GATEWAY_PORT),
    ]);
  });

  it("adds rootless keep-id arguments and private SELinux labels for Podman", () => {
    const args = buildCellRunArgs(
      makeProfile({
        runtime: "podman",
        containerUser: { mode: "podman-keep-id", uid: 501, gid: 20 },
        selinuxRelabel: true,
      }),
      { environmentFile: TEST_ENVIRONMENT_FILE },
    );
    expect(args).toContain("--userns=keep-id");
    expectOption(args, "--user", "501:20");
    expect(args).toContain(`${makeProfile().dataDir}:${FLEET_CONTAINER_STATE_DIR}:Z`);
    expect(args).toContain(`${makeProfile().authSecretDir}:${FLEET_CONTAINER_AUTH_SECRET_DIR}:Z`);
  });

  it("adds private SELinux labels for Docker mounts", () => {
    const profile = makeProfile({ selinuxRelabel: true });
    const args = buildCellRunArgs(profile, { environmentFile: TEST_ENVIRONMENT_FILE });

    expect(args).toContain(`${profile.dataDir}:${FLEET_CONTAINER_STATE_DIR}:Z`);
    expect(args).toContain(`${profile.authSecretDir}:${FLEET_CONTAINER_AUTH_SECRET_DIR}:Z`);
  });

  it("runs rootful Docker with the invoking non-root identity", () => {
    const args = buildCellRunArgs(
      makeProfile({ containerUser: { mode: "numeric", uid: 1001, gid: 1002 } }),
      { environmentFile: TEST_ENVIRONMENT_FILE },
    );

    expectOption(args, "--user", "1001:1002");
    expect(args).not.toContain("--userns=keep-id");
  });

  it("never enables privileged host integration", () => {
    for (const args of [
      buildCellRunArgs(makeProfile(), { environmentFile: TEST_ENVIRONMENT_FILE }),
      buildCellCreateArgs(makeProfile(), { environmentFile: TEST_ENVIRONMENT_FILE }),
    ]) {
      const rendered = args.join(" ");
      expect(rendered).not.toContain("docker.sock");
      expect(args).not.toContain("--privileged");
      expect(args).not.toContain("--network=host");
      expectOption(args, "--network", "openclaw-cell-acme-net");
      expect(args[args.indexOf("--network") + 1]).not.toBe("host");
      expect(rendered).not.toContain("--cap-add");
      expect(rendered).not.toContain("0.0.0.0");
    }
  });
});
