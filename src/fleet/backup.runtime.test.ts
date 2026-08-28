import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { backupFleetCell, restoreFleetCell } from "./backup.runtime.js";
import { cellAuthSecretDir, cellOwnerId } from "./cell-profile.js";
import type { FleetContainerInspectResult, FleetContainerRuntime } from "./containers.runtime.js";
import type { FleetCellRecord } from "./registry.js";

const ATTEMPT = "11111111111111111111111111111111";
const NEXT_ATTEMPT = "22222222222222222222222222222222";
let root: string;
let record: FleetCellRecord;

const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-backup-test-" });

function inspection(running = false): Extract<FleetContainerInspectResult, { kind: "ok" }> {
  return {
    kind: "ok",
    containerId: "container-id",
    state: running ? "running" : "exited",
    running,
    labels: {
      "openclaw.fleet.tenant": "acme",
      "openclaw.fleet.owner": cellOwnerId(record.dataDir),
      "openclaw.fleet.attempt": ATTEMPT,
      "openclaw.fleet.env-keys": "",
      "openclaw.fleet.disk-limit": "10g",
    },
    environment: { OPENCLAW_GATEWAY_TOKEN: "old-token" },
    imageId: "sha256:image",
    memory: "2147483648",
    cpus: "2",
    pidsLimit: 512,
    storageOpt: { size: "10g" },
    capDrop: ["ALL"],
    effectiveCaps: undefined,
    securityOpt: ["no-new-privileges"],
    init: true,
    restartPolicy: "unless-stopped",
    portBindings: [{ containerPort: "18789/tcp", hostIp: "127.0.0.1", hostPort: "19100" }],
    user: "1000:1000",
  };
}

function containerMock(current: FleetContainerInspectResult = inspection()) {
  return {
    assertLocal: vi.fn(async () => undefined),
    inspect: vi.fn(async () => current),
    inspectNetwork: vi.fn(async () => ({
      kind: "ok" as const,
      labels: {
        "openclaw.fleet.tenant": "acme",
        "openclaw.fleet.owner": cellOwnerId(record.dataDir),
      },
      attachedContainers: [{ id: "cell", name: record.containerName }],
      internal: false,
    })),
    isDockerRootless: vi.fn(async () => false),
    run: vi.fn<FleetContainerRuntime["run"]>(async () => undefined),
    pull: vi.fn(async () => undefined),
    createNetwork: vi.fn(async () => undefined),
    removeNetwork: vi.fn(async () => undefined),
    logs: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  } satisfies FleetContainerRuntime;
}

async function createArchive(
  params: { tenant?: string; mutate?: (dir: string) => Promise<void> } = {},
): Promise<string> {
  const source = path.join(root, `archive-source-${crypto.randomUUID()}`);
  await fs.mkdir(path.join(source, "data"), { recursive: true });
  await fs.mkdir(path.join(source, "auth"), { recursive: true });
  await fs.writeFile(
    path.join(source, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "openclaw-fleet-cell-backup",
      tenant: params.tenant ?? "acme",
      createdAt: new Date(0).toISOString(),
      hostPort: 19100,
      image: "image",
      runtime: "docker",
    }),
  );
  await fs.writeFile(path.join(source, "data", "restored.txt"), "new-data");
  await fs.writeFile(path.join(source, "auth", "secret.txt"), "new-auth");
  await params.mutate?.(source);
  const archive = path.join(root, `${path.basename(source)}.tgz`);
  await tar.c({ gzip: true, file: archive, cwd: source }, ["manifest.json", "data", "auth"]);
  return archive;
}

beforeEach(async () => {
  root = await tempRoot.setup();
  record = {
    tenantId: "acme",
    createdAtMs: 0,
    image: "image",
    runtime: "docker",
    hostPort: 19100,
    containerName: "openclaw-cell-acme",
    dataDir: path.join(root, "fleet", "cells", "acme"),
  };
  await fs.mkdir(record.dataDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(cellAuthSecretDir(root, "acme"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(record.dataDir, "state.txt"), "state");
  await fs.writeFile(path.join(cellAuthSecretDir(root, "acme"), "secret.txt"), "secret");
});

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  await tempRoot.cleanup();
});

describe("fleet backup runtime", () => {
  function backupParams(out: string) {
    return {
      record,
      stateDir: root,
      containers: containerMock(),
      now: () => 0,
      checkpoint: () => {},
      out,
    };
  }

  function interruptCopy(archivePath: string, mutate: (targetPath: string) => Promise<void>) {
    const error = Object.assign(new Error("archive copy interrupted"), { code: "EIO" });
    vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("unsupported"), { code: "ENOTSUP" }),
    );
    const copyFile = fs.copyFile.bind(fs);
    const legacyCopy = vi.spyOn(fs, "copyFile").mockImplementation(async (source, target, mode) => {
      if (path.resolve(String(target)) !== archivePath) {
        return await copyFile(source, target, mode);
      }
      await fs.writeFile(target, "");
      await mutate(String(target));
      throw error;
    });
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated: async (method, targetPath) => {
        if (method === "exclusive-copy" && targetPath === archivePath) {
          await mutate(targetPath);
          throw error;
        }
      },
    });
    return legacyCopy;
  }

  it("writes a private archive with manifest, data, and auth while skipping symlinks", async () => {
    const outside = path.join(root, "outside-secret");
    await fs.writeFile(outside, "must-not-archive");
    await fs.symlink(outside, path.join(record.dataDir, "outside-link"));
    const containers = containerMock();
    const publicationMethods: string[] = [];
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated: (method) => {
        publicationMethods.push(method);
      },
    });
    const result = await backupFleetCell({
      record,
      stateDir: root,
      containers,
      now: () => 0,
      checkpoint: () => {},
      out: path.join(root, "backup.tgz"),
    });
    expect((await fs.stat(result.archivePath)).mode & 0o777).toBe(0o600);
    expect(publicationMethods).toEqual(["hardlink"]);
    expect(result.skippedSymlinks).toBe(1);
    const entries: string[] = [];
    const contents: string[] = [];
    await tar.t({
      file: result.archivePath,
      onentry: (entry) => {
        entries.push(entry.path);
        entry.on("data", (chunk) => contents.push(String(chunk)));
      },
    });
    expect(entries).toEqual(
      expect.arrayContaining(["manifest.json", "data/state.txt", "auth/secret.txt"]),
    );
    expect(entries).not.toContain("data/outside-link");
    expect(contents.join("")).not.toContain("must-not-archive");
    const leftovers = (await fs.readdir(path.dirname(result.archivePath))).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("publishes a complete archive through the copy fallback", async () => {
    const archivePath = path.join(root, "copy.tgz");
    vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("unsupported"), { code: "ENOTSUP" }),
    );
    const methods: string[] = [];
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated: (method) => {
        methods.push(method);
      },
    });

    expect((await backupFleetCell(backupParams(archivePath))).archivePath).toBe(archivePath);
    expect(methods).toEqual(["exclusive-copy"]);
    await expect(tar.t({ file: archivePath })).resolves.toBeUndefined();
  });

  it("removes an interrupted owned copy and allows a backup retry", async () => {
    const archivePath = path.join(root, "interrupted.tgz");
    const legacyCopy = interruptCopy(archivePath, (targetPath) =>
      fs.writeFile(targetPath, "partial archive"),
    );

    await expect(backupFleetCell(backupParams(archivePath))).rejects.toThrow(
      /archive copy interrupted/iu,
    );
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    __setFsSafeTestHooksForTest(undefined);
    legacyCopy.mockRestore();
    await expect(backupFleetCell(backupParams(archivePath))).resolves.toMatchObject({
      archivePath,
    });
  });

  it("reports the original failure when an interrupted archive cannot be removed", async () => {
    const archivePath = path.join(root, "cleanup-unknown.tgz");
    interruptCopy(archivePath, (targetPath) => fs.writeFile(targetPath, "partial archive"));
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === archivePath) {
        throw Object.assign(new Error("archive cleanup busy"), { code: "EBUSY" });
      }
      return await remove(target, options);
    });

    const error = await backupFleetCell(backupParams(archivePath)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      message: expect.stringMatching(
        /archive copy interrupted.*partial archive may remain.*inspect.*retry/iu,
      ),
      cause: expect.any(Error),
    });
    expect((error as Error).message).toContain(archivePath);
    await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("partial archive");
  });

  it("preserves a foreign archive that replaces the interrupted publication", async () => {
    const archivePath = path.join(root, "raced.tgz");
    interruptCopy(archivePath, async (targetPath) => {
      await fs.rename(targetPath, `${targetPath}.displaced`);
      await fs.writeFile(targetPath, "foreign archive");
    });

    await expect(backupFleetCell(backupParams(archivePath))).rejects.toThrow(
      /archive copy interrupted/iu,
    );
    await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("foreign archive");
  });

  it("fails and removes its archive when publication directory synchronization fails", async () => {
    const archivePath = path.join(root, "sync-failure.tgz");
    __setFsSafeTestHooksForTest({
      beforePublishDirectorySync: async (_method, targetPath) => {
        if (targetPath === archivePath) {
          throw Object.assign(new Error("archive directory sync failed"), { code: "EIO" });
        }
      },
    });

    await expect(backupFleetCell(backupParams(archivePath))).rejects.toThrow(
      /directory sync failed/iu,
    );
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and removes a copy that fails publication content verification", async () => {
    const archivePath = path.join(root, "integrity-failure.tgz");
    vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("unsupported"), { code: "ENOTSUP" }),
    );
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated: async (method, targetPath) => {
        if (method === "exclusive-copy" && targetPath === archivePath) {
          await fs.writeFile(targetPath, Buffer.alloc(64 * 1024, 1));
        }
      },
    });

    await expect(backupFleetCell(backupParams(archivePath))).rejects.toThrow(/content fencing/iu);
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unsafe or unavailable backup inputs", async () => {
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers: containerMock(inspection(true)),
        now: () => 0,
        checkpoint: () => {},
      }),
    ).rejects.toThrow(/stop it first/iu);
    await fs.rm(cellAuthSecretDir(root, "acme"), { recursive: true });
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers: containerMock(),
        now: () => 0,
        checkpoint: () => {},
      }),
    ).rejects.toThrow(/no auth-secret directory/iu);
    await fs.rm(record.dataDir, { recursive: true });
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers: containerMock(),
        now: () => 0,
        checkpoint: () => {},
      }),
    ).rejects.toThrow(/no cell data/iu);
  });

  it("refuses byte caps, existing outputs, and outputs inside cell data", async () => {
    const containers = containerMock();
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers,
        now: () => 0,
        checkpoint: () => {},
        maxBytes: 1,
        out: path.join(root, "capped.tgz"),
      }),
    ).rejects.toThrow(/--max-bytes/iu);
    const existing = path.join(root, "existing.tgz");
    await fs.writeFile(existing, "exists");
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers,
        now: () => 0,
        checkpoint: () => {},
        out: existing,
      }),
    ).rejects.toThrow(/overwrite/iu);
    await expect(fs.readFile(existing, "utf8")).resolves.toBe("exists");
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers,
        now: () => 0,
        checkpoint: () => {},
        out: path.join(record.dataDir, "bad.tgz"),
      }),
    ).rejects.toThrow(/inside/iu);
  });

  it("refuses file names its own restore rules would reject", async () => {
    await fs.writeFile(path.join(record.dataDir, "weird\\..\\name"), "content");
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers: containerMock(),
        now: () => 0,
        checkpoint: () => {},
        out: path.join(root, "unrestorable.tgz"),
      }),
    ).rejects.toThrow(/restore path rules would reject/iu);
    await expect(fs.lstat(path.join(root, "unrestorable.tgz"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects trees over the entry limit", async () => {
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers: containerMock(),
        now: () => 0,
        checkpoint: () => {},
        maxEntries: 2,
        out: path.join(root, "entry-capped.tgz"),
      }),
    ).rejects.toThrow(/entry limit/iu);
    await expect(fs.lstat(path.join(root, "entry-capped.tgz"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("aborts and discards the archive when the operation lease is lost mid-stream", async () => {
    let clock = 0;
    const archivePath = path.join(root, "lease-lost.tgz");
    await expect(
      backupFleetCell({
        record,
        stateDir: root,
        containers: containerMock(),
        // Each filter probe advances well past the lease-probe interval.
        now: () => (clock += 60_000),
        checkpoint: () => {
          throw new Error("Fleet operation lease was lost for acme.");
        },
        out: archivePath,
      }),
    ).rejects.toThrow(/lost its operation lease/iu);
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("fleet restore runtime", () => {
  function restoreParams(containers: FleetContainerRuntime, from: string) {
    return {
      record,
      stateDir: root,
      containers,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      now: () => 0,
      sleep: async () => {},
      checkpoint: () => {},
      generateToken: () => "new-token",
      generateAttemptId: () => NEXT_ATTEMPT,
      hostIdentity: undefined,
      selinuxRelabel: false,
      from,
    };
  }

  it("rejects tenant mismatch and running cells before mutation", async () => {
    const mismatch = await createArchive({ tenant: "other" });
    const stopped = containerMock();
    await expect(restoreFleetCell(restoreParams(stopped, mismatch))).rejects.toThrow(
      /belongs to tenant other/iu,
    );
    expect(stopped.remove).not.toHaveBeenCalled();
    const archive = await createArchive();
    const running = containerMock(inspection(true));
    await expect(restoreFleetCell(restoreParams(running, archive))).rejects.toThrow(
      /pass --force/iu,
    );
  });

  it("gives a usable recovery sequence when the registered container is missing", async () => {
    const archive = await createArchive();
    const containers = containerMock({ kind: "missing", state: "missing" });

    await expect(restoreFleetCell(restoreParams(containers, archive))).rejects.toThrow(
      /fleet rm acme --force.*fleet create acme --no-start --image <image>.*retry fleet restore/iu,
    );
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("rejects archives inside cell state and foreign cell networks before mutation", async () => {
    const archive = await createArchive();
    const inside = path.join(record.dataDir, "inside.tgz");
    await fs.copyFile(archive, inside);
    const containers = containerMock();
    await expect(restoreFleetCell(restoreParams(containers, inside))).rejects.toThrow(
      /must not be stored inside/iu,
    );
    expect(containers.remove).not.toHaveBeenCalled();

    containers.inspectNetwork.mockResolvedValue({
      kind: "ok",
      labels: { "openclaw.fleet.tenant": "acme", "openclaw.fleet.owner": "foreign" },
      attachedContainers: [],
      internal: false,
    });
    await expect(restoreFleetCell(restoreParams(containers, archive))).rejects.toThrow(
      /ownership labels/iu,
    );
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it.each([
    [
      "symlink",
      async (dir: string) => await fs.symlink("../manifest.json", path.join(dir, "data", "link")),
    ],
    [
      "unexpected root",
      async (dir: string) => await fs.writeFile(path.join(dir, "unexpected"), "bad"),
    ],
  ] as const)("rejects an archive containing %s", async (_label, mutate) => {
    const source = path.join(root, `malicious-${crypto.randomUUID()}`);
    await fs.mkdir(path.join(source, "data"), { recursive: true });
    await fs.writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, kind: "openclaw-fleet-cell-backup", tenant: "acme" }),
    );
    await mutate(source);
    const archive = path.join(root, `${path.basename(source)}.tgz`);
    await tar.c({ gzip: true, file: archive, cwd: source }, ["."]);
    await expect(restoreFleetCell(restoreParams(containerMock(), archive))).rejects.toThrow(
      /tampered/iu,
    );
  });

  it("rejects archives over the entry limit before any destructive step", async () => {
    const archive = await createArchive();
    const containers = containerMock();
    await expect(
      restoreFleetCell({ ...restoreParams(containers, archive), maxEntries: 2 }),
    ).rejects.toThrow(/entry limit/iu);
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("rejects an implicitly deep entry before creating output paths", async () => {
    const source = path.join(root, `deep-${crypto.randomUUID()}`);
    const deepRelativePath = path.posix.join(
      "data",
      ...Array.from({ length: 6 }, (_, index) => `segment-${index}`),
      "state.txt",
    );
    await fs.mkdir(path.join(source, path.dirname(deepRelativePath)), { recursive: true });
    await fs.mkdir(path.join(source, "auth"));
    await fs.writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, kind: "openclaw-fleet-cell-backup", tenant: "acme" }),
    );
    await fs.writeFile(path.join(source, deepRelativePath), "state");
    const archive = path.join(root, `${path.basename(source)}.tgz`);
    await tar.c({ gzip: true, file: archive, cwd: source }, [
      "manifest.json",
      deepRelativePath,
      "auth",
    ]);
    const containers = containerMock();

    await expect(
      restoreFleetCell({ ...restoreParams(containers, archive), maxEntries: 5 }),
    ).rejects.toThrow(/entry limit/iu);
    expect(containers.remove).not.toHaveBeenCalled();
    await expect(fs.readdir(path.join(root, "fleet", "restore-tmp"))).resolves.toEqual([]);
  });

  it("rejects an archive without the auth tree before any destructive step", async () => {
    const source = path.join(root, `auth-less-${crypto.randomUUID()}`);
    await fs.mkdir(path.join(source, "data"), { recursive: true });
    await fs.writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, kind: "openclaw-fleet-cell-backup", tenant: "acme" }),
    );
    await fs.writeFile(path.join(source, "data", "restored.txt"), "new-data");
    const archive = path.join(root, `${path.basename(source)}.tgz`);
    await tar.c({ gzip: true, file: archive, cwd: source }, ["manifest.json", "data"]);
    const containers = containerMock();
    await expect(restoreFleetCell(restoreParams(containers, archive))).rejects.toThrow(
      /tampered/iu,
    );
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(cellAuthSecretDir(root, "acme"), "secret.txt"), "utf8"),
    ).resolves.toBe("secret");
  });

  it("fails preflight on a drifted container before any destructive step", async () => {
    const archive = await createArchive();
    const drifted = inspection();
    // Losing the env-provenance label makes the replacement profile unbuildable;
    // restore must detect that before stopping or removing anything.
    delete drifted.labels["openclaw.fleet.env-keys"];
    const containers = containerMock(drifted);
    await expect(restoreFleetCell(restoreParams(containers, archive))).rejects.toThrow(
      /Cannot restore cell/iu,
    );
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(record.dataDir, "state.txt"), "utf8")).resolves.toBe(
      "state",
    );
  });

  it("swaps state, repins config, and rotates the token", async () => {
    const archive = await createArchive();
    const containers = containerMock();
    const result = await restoreFleetCell(restoreParams(containers, archive));
    await expect(fs.readFile(path.join(record.dataDir, "restored.txt"), "utf8")).resolves.toBe(
      "new-data",
    );
    await expect(fs.lstat(path.join(record.dataDir, "state.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const config = JSON.parse(
      await fs.readFile(path.join(record.dataDir, "openclaw.json"), "utf8"),
    ) as { gateway?: { controlUi?: { allowedOrigins?: string[] } } };
    expect(config.gateway?.controlUi?.allowedOrigins).toContain("http://127.0.0.1:19100");
    expect(containers.run.mock.calls[0]?.[0].environment.OPENCLAW_GATEWAY_TOKEN).toBe("new-token");
    // The disk limit must survive restore via the fleet label even on Podman,
    // whose inspect schema has no HostConfig.StorageOpt.
    expect(containers.run.mock.calls[0]?.[0].diskSize).toBe("10g");
    expect(containers.run.mock.calls[0]?.[0].environment.OPENCLAW_GATEWAY_TOKEN).not.toBe(
      "old-token",
    );
    expect(containers.run).toHaveBeenCalledWith(expect.any(Object), false);
    expect(result.started).toBe(false);
    await expect(fs.readdir(path.join(root, "fleet", "restore-tmp"))).resolves.toEqual([]);
  });

  it("restarts a force-stopped cell when restore fails before removal", async () => {
    const archive = await createArchive();
    const running = inspection(true);
    const containers = containerMock(running);
    containers.stop.mockImplementation(async () => {
      running.running = false;
      running.state = "exited";
    });
    containers.remove.mockRejectedValue(new Error("transient removal failure"));
    await expect(
      restoreFleetCell({ ...restoreParams(containers, archive), force: true }),
    ).rejects.toThrow(/transient removal failure/iu);
    expect(containers.start).toHaveBeenCalledWith("docker", "openclaw-cell-acme");
    await expect(fs.readFile(path.join(record.dataDir, "state.txt"), "utf8")).resolves.toBe(
      "state",
    );
  });

  it("stops an unhealthy started replacement so its undelivered token cannot serve", async () => {
    const archive = await createArchive();
    const running = inspection(true);
    const containers = containerMock(running);
    containers.stop.mockImplementation(async () => {
      running.running = false;
      running.state = "exited";
    });
    containers.run.mockImplementation(async () => {
      running.running = true;
      running.state = "running";
      running.labels["openclaw.fleet.attempt"] = NEXT_ATTEMPT;
    });
    let clock = 0;
    let message = "";
    try {
      await restoreFleetCell({
        ...restoreParams(containers, archive),
        force: true,
        fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
        now: () => (clock += 61_000),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/replacement container was stopped/iu);
    expect(containers.stop).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-root invoker", { uid: 501, gid: 20 }, undefined, undefined],
    ["root with image-default user", { uid: 0, gid: 0 }, undefined, { uid: 1000, gid: 1000 }],
    [
      "root with explicit non-root mapping",
      { uid: 0, gid: 0 },
      "1001:1002",
      { uid: 1001, gid: 1002 },
    ],
    ["root with rootless uid-0 mapping", { uid: 0, gid: 0 }, "0:0", undefined],
  ] as const)("repairs restored ownership for %s", async (_label, hostIdentity, user, expected) => {
    const archive = await createArchive();
    const current = inspection();
    current.user = user;
    const containers = containerMock(current);
    const chown = vi.spyOn(fs, "chown").mockResolvedValue();

    await restoreFleetCell({
      ...restoreParams(containers, archive),
      hostIdentity,
    });

    if (!expected) {
      expect(chown).not.toHaveBeenCalled();
      return;
    }
    expect(chown).toHaveBeenCalled();
    for (const [, uid, gid] of chown.mock.calls) {
      expect({ uid, gid }).toEqual(expected);
    }
  });

  it("preserves replaced and extracted trees when replacement run fails", async () => {
    const archive = await createArchive();
    const containers = containerMock();
    containers.run.mockRejectedValue(new Error("run failed"));
    let message = "";
    try {
      await restoreFleetCell(restoreParams(containers, archive));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/displaced previous data is preserved at .*\/replaced/iu);
    const preserved = message.match(/preserved at (.+)\/replaced\./u)?.[1];
    expect(preserved).toBeTruthy();
    await expect(
      fs.readFile(path.join(preserved ?? "", "replaced", "data", "state.txt"), "utf8"),
    ).resolves.toBe("state");
  });
});
