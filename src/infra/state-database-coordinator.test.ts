import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
  withStateSchemaFence,
} from "./state-database-coordinator.js";
import { createVitestResourceOwner } from "./vitest-resource-ownership.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resourceContextPreload = pathToFileURL(
  path.join(repositoryRoot, "src/infra/vitest-resource-context-preload.test-support.ts"),
).href;

function withResourceContextPreload(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, NODE_OPTIONS: `--import=${resourceContextPreload}` };
}

describe("state database coordinator", () => {
  it("routes isolated databases through the owned root and releases its claim", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-claim-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const coordinator = coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const claim = path.join(claims, fs.readdirSync(claims)[0]);
        const pendingWhileHeld = !fs.existsSync(path.join(claim, "released"));
        coordinator.release();
        console.log(JSON.stringify({ path: coordinator.path, pendingWhileHeld, released: fs.existsSync(path.join(claim, "released")), runtimeDirectory: coordinatorModule.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)}) }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toMatchObject({
      pendingWhileHeld: true,
      released: true,
      runtimeDirectory: ownedRoot,
    });
    expect((result.path as string).startsWith(`${ownedRoot}${path.sep}`)).toBe(true);
    expect(() => owner.assertReleased()).not.toThrow();
  });

  it("claims both the database owner and a distinct explicit coordinator owner", () => {
    const databaseResource = createStandaloneOwner("openclaw-coordinator-database-owner-");
    const coordinatorResource = createStandaloneOwner("openclaw-coordinator-path-owner-");
    const databasePath = path.join(databaseResource.ownedRoot, "state", "openclaw.sqlite");
    const coordinatorPath = path.join(
      coordinatorResource.ownedRoot,
      "custom-locks",
      "gateway.lock.sqlite",
    );
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const claimState = (root) => {
          const claims = path.join(root, ".vitest-resource-owner", "claims");
          return fs.readdirSync(claims).map((claim) => fs.existsSync(path.join(claims, claim, "released")));
        };
        const coordinator = coordinatorModule.acquireGatewayLifecycleCoordinator({
          databasePath: ${JSON.stringify(databasePath)},
          coordinatorPath: ${JSON.stringify(coordinatorPath)},
          busyTimeoutMs: 0,
        });
        const held = {
          database: claimState(${JSON.stringify(databaseResource.ownedRoot)}),
          coordinator: claimState(${JSON.stringify(coordinatorResource.ownedRoot)}),
        };
        coordinator.release();
        console.log(JSON.stringify({
          path: coordinator.path,
          held,
          released: {
            database: claimState(${JSON.stringify(databaseResource.ownedRoot)}),
            coordinator: claimState(${JSON.stringify(coordinatorResource.ownedRoot)}),
          },
        }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: databaseResource.ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          {
            root: databaseResource.ownedRoot,
            identity: databaseResource.owner.identity,
          },
          {
            root: coordinatorResource.ownedRoot,
            identity: coordinatorResource.owner.identity,
          },
        ]),
      },
    );

    expect(result).toEqual({
      path: coordinatorPath,
      held: { database: [false], coordinator: [false] },
      released: { database: [true], coordinator: [true] },
    });
    expect(() => databaseResource.owner.assertReleased()).not.toThrow();
    expect(() => coordinatorResource.owner.assertReleased()).not.toThrow();
  });

  it("releases its claim when rollback reports failure after SQLite close succeeds", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-release-failure-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { DatabaseSync } = await import("node:sqlite");
        const coordinator = coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        const nativeExec = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function(sql) {
          if (sql === "ROLLBACK") throw new Error("simulated rollback failure");
          return nativeExec.call(this, sql);
        };
        let errorMessage;
        try { coordinator.release(); } catch (error) { errorMessage = error.message; }
        DatabaseSync.prototype.exec = nativeExec;
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const claim = path.join(claims, fs.readdirSync(claims)[0]);
        console.log(JSON.stringify({ errorMessage, released: fs.existsSync(path.join(claim, "released")) }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toEqual({
      errorMessage: expect.stringContaining("failed to release state-lifecycle coordinator"),
      released: true,
    });
    expect(() => owner.assertReleased()).not.toThrow();
  });

  it("retains its claim when SQLite close does not succeed", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-close-failure-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { DatabaseSync } = await import("node:sqlite");
        const coordinator = coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        const nativeClose = DatabaseSync.prototype.close;
        DatabaseSync.prototype.close = function() {
          throw new Error("simulated close failure");
        };
        let errorMessage;
        try { coordinator.release(); } catch (error) { errorMessage = error.message; }
        DatabaseSync.prototype.close = nativeClose;
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const claim = path.join(claims, fs.readdirSync(claims)[0]);
        console.log(JSON.stringify({ errorMessage, released: fs.existsSync(path.join(claim, "released")) }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toEqual({
      errorMessage: expect.stringContaining("failed to release state-lifecycle coordinator"),
      released: false,
    });
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
  });

  it("fails closed without recreating an owner removed after import", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-removed-owner-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        fs.rmSync(${JSON.stringify(ownedRoot)}, { recursive: true });
        let errorCode;
        try {
          coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        } catch (error) {
          errorCode = error.code;
        }
        console.log(JSON.stringify({ errorCode, recreated: fs.existsSync(${JSON.stringify(ownedRoot)}) }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toEqual({ errorCode: "ENOENT", recreated: false });
  });

  it("uses the launcher's stable production lock root", () => {
    expect(process.env.VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT).toBeTruthy();
    expect(resolveStateLifecycleRuntimeDirectory()).toBe(
      process.env.VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT,
    );
  });

  it("rejects a resource root without an identity-bearing chain", () => {
    const { ownedRoot } = createStandaloneOwner("openclaw-coordinator-missing-chain-");
    const source = `
      let errorMessage;
      try {
        await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
      } catch (error) {
        errorMessage = error.message;
      }
      console.log(JSON.stringify({ errorMessage }));
    `;
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
    });
    delete env.VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN;
    const child = spawnSync(
      process.execPath,
      ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(
      "Inherited Vitest resource root requires an identity-bearing chain",
    );
  });

  it("rejects an identity-bearing chain without its resource root", () => {
    const { ownedRoot, owner } = createStandaloneOwner(
      "openclaw-coordinator-missing-resource-root-",
    );
    const source = `
      let errorMessage;
      try {
        await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
      } catch (error) {
        errorMessage = error.message;
      }
      console.log(JSON.stringify({ errorMessage }));
    `;
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
        { root: ownedRoot, identity: owner.identity },
      ]),
    });
    delete env.VITEST_OPENCLAW_RESOURCE_ROOT;
    const child = spawnSync(
      process.execPath,
      ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("Inherited Vitest resource root chain requires its root marker");
  });

  it("rejects a validated resource lineage without a production lock root", () => {
    const { ownedRoot, owner } = createStandaloneOwner(
      "openclaw-coordinator-missing-production-root-",
    );
    const source = `
      let errorMessage;
      try {
        await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
      } catch (error) {
        errorMessage = error.message;
      }
      console.log(JSON.stringify({ errorMessage }));
    `;
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
        { root: ownedRoot, identity: owner.identity },
      ]),
    });
    delete env.VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT;
    const child = spawnSync(
      process.execPath,
      ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(
      "Inherited Vitest resource lineage requires a production lock root",
    );
  });

  it("rejects stale resource lineage in the process preload", () => {
    const root = tempDirs.make("openclaw-coordinator-stale-preload-");
    const staleRoot = path.join(root, "missing-owner");
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT: staleRoot,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
        { root: staleRoot, identity: "00000000-0000-0000-0000-000000000000" },
      ]),
    });
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(resolveCoordinatorModuleUrl())})`,
      ],
      {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(`Invalid inherited Vitest resource root: ${staleRoot}`);
  });

  it("ignores an unpaired production lock root marker", () => {
    const changedHome = tempDirs.make("openclaw-unpaired-production-root-");
    const spoofedRoot = path.join(changedHome, "spoofed-locks");
    const result = runCoordinatorSource(
      `
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        console.log(JSON.stringify({ runtimeDirectory: coordinatorModule.resolveStateLifecycleRuntimeDirectory() }));
      `,
      {
        VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT: spoofedRoot,
        HOME: changedHome,
        USERPROFILE: changedHome,
      },
      ["VITEST_OPENCLAW_RESOURCE_ROOT", "VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN"],
    );
    const expectedRoot =
      process.platform === "win32"
        ? path.join(changedHome, "AppData", "Local", "OpenClaw", "locks")
        : "/tmp";

    expect(result).toEqual({ runtimeDirectory: expectedRoot });
  });

  it("ignores unrelated resource-owner metadata outside the captured root", () => {
    const globalRuntime = resolveStateLifecycleRuntimeDirectory();
    fs.mkdirSync(globalRuntime, { recursive: true });
    const root = tempDirs.make(
      "openclaw-unrelated-resource-owner-",
      fs.realpathSync(globalRuntime),
    );
    const runtimeAncestor = path.join(root, "runtime-ancestor");
    const metadata = path.join(runtimeAncestor, ".vitest-resource-owner");
    fs.mkdirSync(path.join(metadata, "claims"), { recursive: true });
    fs.writeFileSync(path.join(metadata, "owner"), "not-a-valid-owner");
    const runtimeDirectory = path.join(runtimeAncestor, "runtime");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const coordinator = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    try {
      expect(coordinator.path.startsWith(`${runtimeDirectory}${path.sep}`)).toBe(true);
    } finally {
      coordinator.release();
    }
  });

  it("keeps external databases on the stable global coordinator and contends there", () => {
    const globalRuntime = resolveStateLifecycleRuntimeDirectory();
    fs.mkdirSync(globalRuntime, { recursive: true });
    const root = tempDirs.make("openclaw-external-state-", fs.realpathSync(globalRuntime));
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const coordinator = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
    const expectedStatePath = resolveStateDatabaseCoordinatorPath({
      databasePath,
      runtimeDirectory: globalRuntime,
      uid: process.getuid?.(),
    });
    const expectedPath = expectedStatePath.replace("state-lifecycle.", "gateway-lifecycle.");

    try {
      expect(resolveStateLifecycleRuntimeDirectory(databasePath)).toBe(globalRuntime);
      expect(coordinator.path).toBe(expectedPath);
      const child = runCoordinatorPeer(databasePath, path.join(root, "changed-tmp"));
      expect(child).toMatchObject({
        runtimeDirectory: globalRuntime,
        errorName: "StateDatabaseCoordinatorContentionError",
      });
    } finally {
      coordinator.release();
      fs.rmSync(expectedPath, { force: true });
    }
  });

  it("inherits one resource root across child TMPDIR and VITEST changes", () => {
    const ownedRoot = fs.realpathSync(process.env.VITEST_OPENCLAW_RESOURCE_ROOT!);
    const root = tempDirs.make("openclaw-stable-resource-root-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const coordinator = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
    try {
      expect(runCoordinatorPeer(databasePath, path.join(root, "changed-tmp"))).toMatchObject({
        runtimeDirectory: ownedRoot,
        errorName: "StateDatabaseCoordinatorContentionError",
      });
    } finally {
      coordinator.release();
    }
  });

  it("keeps owned coordination in post-setup spawned and forked descendants", async () => {
    const ownedRoot = fs.realpathSync(process.env.VITEST_OPENCLAW_RESOURCE_ROOT!);
    expect(process.env.NODE_OPTIONS).toBe(`--import=${resourceContextPreload}`);
    const fixtureRoot = tempDirs.make("openclaw-post-setup-descendant-");
    const databasePath = path.join(ownedRoot, "post-setup-descendant", "openclaw.sqlite");
    const entry = path.join(fixtureRoot, "probe.mts");
    fs.writeFileSync(
      entry,
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const before = new Set(fs.readdirSync(claims));
        const coordinator = coordinatorModule.acquireGatewayLifecycleCoordinator({
          databasePath: ${JSON.stringify(databasePath)},
          busyTimeoutMs: 0,
        });
        const added = fs.readdirSync(claims).filter((claim) => !before.has(claim));
        const pending = added.length === 1 && !fs.existsSync(path.join(claims, added[0], "released"));
        coordinator.release();
        console.log(JSON.stringify({
          path: coordinator.path,
          pending,
          released: added.length === 1 && fs.existsSync(path.join(claims, added[0], "released")),
          runtimeDirectory: coordinatorModule.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)}),
        }));
      `,
    );
    const execArgv = ["--disable-warning=DEP0205", "--import", "tsx"];
    const spawned = spawnSync(process.execPath, [...execArgv, entry], {
      cwd: repositoryRoot,
      env: process.env,
      encoding: "utf8",
    });
    expect(spawned.stderr).toBe("");
    expect(spawned.status).toBe(0);

    const forked = fork(entry, [], {
      cwd: repositoryRoot,
      env: process.env,
      execArgv,
      silent: true,
    });
    let forkedOutput = "";
    let forkedErrors = "";
    forked.stdout!.on("data", (chunk) => {
      forkedOutput += chunk;
    });
    forked.stderr!.on("data", (chunk) => {
      forkedErrors += chunk;
    });
    const forkedExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        forked.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    expect(forkedErrors).toBe("");
    expect(forkedExit).toEqual({ code: 0, signal: null });

    for (const output of [spawned.stdout, forkedOutput]) {
      const result = JSON.parse(output) as {
        path: string;
        pending: boolean;
        released: boolean;
        runtimeDirectory: string;
      };
      expect(result).toMatchObject({ pending: true, released: true, runtimeDirectory: ownedRoot });
      expect(result.path.startsWith(`${ownedRoot}${path.sep}`)).toBe(true);
    }
  });

  it("reference-counts same-process owners", async () => {
    const root = tempDirs.make("openclaw-state-database-coordinator-");
    const databasePath = path.join(root, "selected-state", "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.promises.mkdir(path.dirname(databasePath), { recursive: true });
    const first = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    const nested = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });

    first.release();
    nested.release();

    const next = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    next.release();
  });

  it("keeps Gateway presence independent from short state operations", async () => {
    const root = tempDirs.make("openclaw-gateway-lifecycle-coordinator-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.promises.mkdir(path.dirname(databasePath), { recursive: true });
    const gateway = acquireGatewayLifecycleCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    const state = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });

    state.release();
    gateway.release();
  });

  it("allows the owning Gateway process to mutate its own schema", async () => {
    const root = tempDirs.make("openclaw-gateway-schema-owner-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.promises.mkdir(path.dirname(databasePath), { recursive: true });
    const gateway = acquireGatewayLifecycleCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    try {
      expect(withStateSchemaFence({ databasePath, runtimeDirectory }, () => "mutated")).toBe(
        "mutated",
      );
    } finally {
      gateway.release();
    }
  });
});

function runCoordinatorPeer(databasePath: string, changedTmp: string) {
  fs.mkdirSync(changedTmp, { recursive: true });
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dirname, "state-database-coordinator.ts"),
  ).href;
  const source = `
    process.env.TMPDIR = ${JSON.stringify(changedTmp)};
    process.env.TMP = ${JSON.stringify(changedTmp)};
    process.env.TEMP = ${JSON.stringify(changedTmp)};
    process.env.HOME = ${JSON.stringify(changedTmp)};
    process.env.USERPROFILE = ${JSON.stringify(changedTmp)};
    delete process.env.VITEST;
    const coordinator = await import(${JSON.stringify(moduleUrl)});
    const runtimeDirectory = coordinator.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)});
    let errorName;
    try {
      coordinator.acquireGatewayLifecycleCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
    } catch (error) {
      errorName = error?.name;
    }
    console.log(JSON.stringify({ runtimeDirectory, errorName }));
  `;
  const env = withResourceContextPreload({ ...process.env });
  delete env.VITEST;
  const child = spawnSync(
    process.execPath,
    ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: repositoryRoot, env, encoding: "utf8" },
  );
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as { runtimeDirectory: string; errorName?: string };
}

function resolveCoordinatorModuleUrl(): string {
  return pathToFileURL(path.join(import.meta.dirname, "state-database-coordinator.ts")).href;
}

function createStandaloneOwner(prefix: string) {
  const globalRuntime = resolveStateLifecycleRuntimeDirectory();
  fs.mkdirSync(globalRuntime, { recursive: true });
  const outerRoot = tempDirs.make(prefix, fs.realpathSync(globalRuntime));
  const ownedRoot = path.join(outerRoot, "owned");
  fs.mkdirSync(ownedRoot);
  return { ownedRoot, owner: createVitestResourceOwner(ownedRoot) };
}

function runCoordinatorSource(
  source: string,
  envOverrides: NodeJS.ProcessEnv,
  removedEnvKeys: string[] = [],
) {
  const env = withResourceContextPreload({ ...process.env, ...envOverrides });
  for (const key of removedEnvKeys) {
    delete env[key];
  }
  const child = spawnSync(
    process.execPath,
    ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    },
  );
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}
