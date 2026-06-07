// Sandbox registry tests cover legacy registry migration, ordering,
// and race-safety for container/browser runtime records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const {
  TEST_STATE_DIR,
  PREVIOUS_OPENCLAW_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
} = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = baseDir;

  return {
    TEST_STATE_DIR: baseDir,
    PREVIOUS_OPENCLAW_STATE_DIR: previousStateDir,
    SANDBOX_REGISTRY_PATH: path.join(baseDir, "containers.json"),
    SANDBOX_BROWSER_REGISTRY_PATH: path.join(baseDir, "browsers.json"),
    SANDBOX_CONTAINERS_DIR: path.join(baseDir, "containers"),
    SANDBOX_BROWSERS_DIR: path.join(baseDir, "browsers"),
  };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
}));

import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { hashTextSha256 } from "./hash.js";
import {
  migrateLegacySandboxRegistryFiles,
  readBrowserRegistry,
  readRegistry,
  readRegistryEntry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;
type MigrationResult = Awaited<ReturnType<typeof migrateLegacySandboxRegistryFiles>>[number];

async function seedMalformedContainerRegistry(payload: string) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, payload, "utf-8");
}

async function seedMalformedBrowserRegistry(payload: string) {
  await fs.writeFile(SANDBOX_BROWSER_REGISTRY_PATH, payload, "utf-8");
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(path.join(TEST_STATE_DIR, "state"), { recursive: true, force: true });
  await fs.rm(SANDBOX_CONTAINERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_BROWSERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
  await fs.rm(SANDBOX_BROWSER_REGISTRY_PATH, { force: true });
  await fs.rm(`${SANDBOX_REGISTRY_PATH}.lock`, { force: true });
  await fs.rm(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`, { force: true });
});

afterAll(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
  if (PREVIOUS_OPENCLAW_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = PREVIOUS_OPENCLAW_STATE_DIR;
  }
});

function browserEntry(
  overrides: Partial<SandboxBrowserRegistryEntry> = {},
): SandboxBrowserRegistryEntry {
  return {
    containerName: "browser-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-browser:test",
    cdpPort: 9222,
    ...overrides,
  };
}

function containerEntry(overrides: Partial<SandboxRegistryEntry> = {}): SandboxRegistryEntry {
  return {
    containerName: "container-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-sandbox:test",
    ...overrides,
  };
}

async function seedContainerRegistry(entries: SandboxRegistryEntry[]) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
}

async function seedBrowserRegistry(entries: SandboxBrowserRegistryEntry[]) {
  await fs.writeFile(
    SANDBOX_BROWSER_REGISTRY_PATH,
    `${JSON.stringify({ entries }, null, 2)}\n`,
    "utf-8",
  );
}

async function seedShardedContainerRegistry(entries: SandboxRegistryEntry[]) {
  await fs.mkdir(SANDBOX_CONTAINERS_DIR, { recursive: true });
  for (const entry of entries) {
    await fs.writeFile(
      path.join(SANDBOX_CONTAINERS_DIR, `${hashTextSha256(entry.containerName)}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
      "utf-8",
    );
  }
}

async function seedShardedBrowserRegistry(entries: SandboxBrowserRegistryEntry[]) {
  await fs.mkdir(SANDBOX_BROWSERS_DIR, { recursive: true });
  for (const entry of entries) {
    await fs.writeFile(
      path.join(SANDBOX_BROWSERS_DIR, `${hashTextSha256(entry.containerName)}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
      "utf-8",
    );
  }
}

async function seedStaleLock(lockPath: string) {
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ pid: 999_999_999, createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    "utf-8",
  );
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected ${targetPath} to be missing`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    expect(code).toBe("ENOENT");
  }
}

function requireMigrationResult(
  results: readonly MigrationResult[],
  kind: MigrationResult["kind"],
): MigrationResult {
  const result = results.find((candidate) => candidate.kind === kind);
  if (!result) {
    throw new Error(`expected migration result for ${kind}`);
  }
  return result;
}

describe("registry race safety", () => {
  it("does not migrate legacy registry files from runtime reads", async () => {
    // Runtime reads should ignore old monolithic files; explicit doctor/repair
    // owns migration so normal startup cannot mutate registry layout.
    await seedContainerRegistry([containerEntry({ containerName: "legacy-container" })]);

    await expect(readRegistry()).resolves.toEqual({ entries: [] });
    await expect(readRegistryEntry("legacy-container")).resolves.toBeNull();
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).resolves.toBeUndefined();
  });

  it("normalizes legacy registry entries after explicit migration", async () => {
    await seedContainerRegistry([
      {
        containerName: "legacy-container",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:test",
      },
    ]);

    await migrateLegacySandboxRegistryFiles();
    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(1);
    const [entry] = registry.entries;
    expect(entry?.containerName).toBe("legacy-container");
    expect(entry?.backendId).toBe("docker");
    expect(entry?.runtimeLabel).toBe("legacy-container");
    expect(entry?.configLabelKind).toBe("Image");
  });

  it("migrates legacy monolithic container and browser registry files after explicit repair", async () => {
    await seedContainerRegistry([
      containerEntry({
        containerName: "legacy-container",
        sessionKey: "agent:legacy",
        lastUsedAtMs: 7,
        configHash: "legacy-container-hash",
      }),
    ]);
    await seedBrowserRegistry([
      browserEntry({
        containerName: "legacy-browser",
        sessionKey: "agent:legacy",
        cdpPort: 9333,
        noVncPort: 6081,
        configHash: "legacy-browser-hash",
      }),
    ]);
    await seedStaleLock(`${SANDBOX_REGISTRY_PATH}.lock`);
    await seedStaleLock(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`);

    const migrationResults = await migrateLegacySandboxRegistryFiles();
    const containerMigration = requireMigrationResult(migrationResults, "containers");
    const browserMigration = requireMigrationResult(migrationResults, "browsers");
    expect(containerMigration.status).toBe("migrated");
    expect(containerMigration.entries).toBe(1);
    expect(browserMigration.status).toBe("migrated");
    expect(browserMigration.entries).toBe(1);

    await expectPathMissing(SANDBOX_REGISTRY_PATH);
    await expectPathMissing(SANDBOX_BROWSER_REGISTRY_PATH);
    await expectPathMissing(`${SANDBOX_REGISTRY_PATH}.lock`);
    await expectPathMissing(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`);
    const containerRegistry = await readRegistry();
    expect(containerRegistry.entries).toHaveLength(1);
    const [container] = containerRegistry.entries;
    expect(container?.containerName).toBe("legacy-container");
    expect(container?.backendId).toBe("docker");
    expect(container?.runtimeLabel).toBe("legacy-container");
    expect(container?.sessionKey).toBe("agent:legacy");
    expect(container?.configHash).toBe("legacy-container-hash");
    const browserRegistry = await readBrowserRegistry();
    expect(browserRegistry.entries).toHaveLength(1);
    const [browser] = browserRegistry.entries;
    expect(browser?.containerName).toBe("legacy-browser");
    expect(browser?.sessionKey).toBe("agent:legacy");
    expect(browser?.cdpPort).toBe(9333);
    expect(browser?.noVncPort).toBe(6081);
    expect(browser?.configHash).toBe("legacy-browser-hash");
  });

  it("migrates legacy sharded container and browser registry files after explicit repair", async () => {
    await seedShardedContainerRegistry([
      containerEntry({
        containerName: "legacy-container",
        sessionKey: "agent:legacy",
        lastUsedAtMs: 7,
        configHash: "legacy-container-hash",
      }),
    ]);
    await seedShardedBrowserRegistry([
      browserEntry({
        containerName: "legacy-browser",
        sessionKey: "agent:legacy",
        cdpPort: 9333,
        noVncPort: 6081,
        configHash: "legacy-browser-hash",
      }),
    ]);

    const migrationResults = await migrateLegacySandboxRegistryFiles();
    expect(requireMigrationResult(migrationResults, "containers").status).toBe("migrated");
    expect(requireMigrationResult(migrationResults, "browsers").status).toBe("migrated");
    await expectPathMissing(SANDBOX_CONTAINERS_DIR);
    await expectPathMissing(SANDBOX_BROWSERS_DIR);
    expect((await readRegistry()).entries[0]?.containerName).toBe("legacy-container");
    expect((await readBrowserRegistry()).entries[0]?.containerName).toBe("legacy-browser");
  });

  it("does not overwrite newer SQLite entries during legacy migration", async () => {
    await updateRegistry(
      containerEntry({
        containerName: "container-a",
        sessionKey: "new-session",
        lastUsedAtMs: 10,
      }),
    );
    await seedContainerRegistry([
      containerEntry({
        containerName: "container-a",
        sessionKey: "legacy-session",
        lastUsedAtMs: 1,
      }),
    ]);

    await migrateLegacySandboxRegistryFiles();

    const entry = await readRegistryEntry("container-a");
    expect(entry?.sessionKey).toBe("new-session");
    expect(entry?.lastUsedAtMs).toBe(10);
  });

  it("prefers newer sharded entries over stale monolithic entries during legacy migration", async () => {
    await seedContainerRegistry([
      containerEntry({
        containerName: "container-a",
        sessionKey: "legacy-session",
        lastUsedAtMs: 1,
      }),
    ]);
    await seedShardedContainerRegistry([
      containerEntry({
        containerName: "container-a",
        sessionKey: "sharded-session",
        lastUsedAtMs: 10,
      }),
    ]);

    await migrateLegacySandboxRegistryFiles();

    const entry = await readRegistryEntry("container-a");
    expect(entry?.sessionKey).toBe("sharded-session");
    expect(entry?.lastUsedAtMs).toBe(10);
  });

  it("reads a single SQLite entry without scanning the full registry", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x", sessionKey: "sess:x" }));
    await updateRegistry(containerEntry({ containerName: "container-y", sessionKey: "sess:y" }));

    const entry = await readRegistryEntry("container-x");
    expect(entry?.containerName).toBe("container-x");
    expect(entry?.sessionKey).toBe("sess:x");
    await expect(readRegistryEntry("missing-container")).resolves.toBeNull();
  });

  it("keeps both container updates under concurrent writes", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["container-a", "container-b"]);
  });

  it("prevents concurrent container remove/update from resurrecting deleted entries", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x" }));

    const updatePromise = updateRegistry(
      containerEntry({ containerName: "container-x", configHash: "updated" }),
    );
    const removePromise = removeRegistryEntry("container-x");
    await Promise.all([updatePromise, removePromise]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("stores unsafe container names without writing path-derived files", async () => {
    await updateRegistry(containerEntry({ containerName: "../escape" }));

    const registry = await readRegistry();

    expect(registry.entries.map((entry) => entry.containerName)).toEqual(["../escape"]);
    await expectPathMissing(`${TEST_STATE_DIR}/escape.json`);
  });

  it("returns registry entries in deterministic container-name order", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-c" })),
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(registry.entries.map((entry) => entry.containerName)).toEqual([
      "container-a",
      "container-b",
      "container-c",
    ]);
  });

  it("keeps both browser updates under concurrent writes", async () => {
    await Promise.all([
      updateBrowserRegistry(browserEntry({ containerName: "browser-a" })),
      updateBrowserRegistry(browserEntry({ containerName: "browser-b", cdpPort: 9223 })),
    ]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["browser-a", "browser-b"]);
  });

  it("prevents concurrent browser remove/update from resurrecting deleted entries", async () => {
    await updateBrowserRegistry(browserEntry({ containerName: "browser-x" }));

    const updatePromise = updateBrowserRegistry(
      browserEntry({ containerName: "browser-x", configHash: "updated" }),
    );
    const removePromise = removeBrowserRegistryEntry("browser-x");
    await Promise.all([updatePromise, removePromise]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("quarantines malformed legacy registry files during migration", async () => {
    await seedMalformedContainerRegistry("{bad json");
    await seedMalformedBrowserRegistry("{bad json");
    const results = await migrateLegacySandboxRegistryFiles();

    await expectPathMissing(SANDBOX_REGISTRY_PATH);
    await expectPathMissing(SANDBOX_BROWSER_REGISTRY_PATH);
    expect(results.map((result) => result.status)).toEqual([
      "quarantined-invalid",
      "quarantined-invalid",
    ]);
  });

  it("quarantines legacy registry files with invalid entries during migration", async () => {
    const invalidEntries = `{"entries":[{"sessionKey":"agent:main"}]}`;
    await seedMalformedContainerRegistry(invalidEntries);
    await seedMalformedBrowserRegistry(invalidEntries);
    const migrationResults = await migrateLegacySandboxRegistryFiles();
    expect(requireMigrationResult(migrationResults, "containers").status).toBe(
      "quarantined-invalid",
    );
    expect(requireMigrationResult(migrationResults, "browsers").status).toBe("quarantined-invalid");
  });

  it("quarantines malformed sharded registry directories during migration", async () => {
    await fs.mkdir(SANDBOX_CONTAINERS_DIR, { recursive: true });
    await fs.mkdir(SANDBOX_BROWSERS_DIR, { recursive: true });
    await seedShardedContainerRegistry([
      containerEntry({ containerName: "valid-container", sessionKey: "agent:valid" }),
    ]);
    await seedShardedBrowserRegistry([
      browserEntry({ containerName: "valid-browser", sessionKey: "agent:valid" }),
    ]);
    await fs.writeFile(path.join(SANDBOX_CONTAINERS_DIR, "bad.json"), "{bad json", "utf-8");
    await fs.writeFile(path.join(SANDBOX_BROWSERS_DIR, "bad.json"), "{bad json", "utf-8");

    const migrationResults = await migrateLegacySandboxRegistryFiles();

    expect(requireMigrationResult(migrationResults, "containers").status).toBe(
      "quarantined-invalid",
    );
    expect(requireMigrationResult(migrationResults, "browsers").status).toBe("quarantined-invalid");
    expect((await readRegistry()).entries[0]?.containerName).toBe("valid-container");
    expect((await readBrowserRegistry()).entries[0]?.containerName).toBe("valid-browser");
    await expectPathMissing(SANDBOX_CONTAINERS_DIR);
    await expectPathMissing(SANDBOX_BROWSERS_DIR);
  });
});
