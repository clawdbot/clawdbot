// Doctor sandbox legacy registry tests cover migration, ordering, and invalid source cleanup.
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
  const nodePath = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(nodePath.join(tmpdir(), "openclaw-sandbox-registry-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", baseDir);

  return {
    TEST_STATE_DIR: baseDir,
    PREVIOUS_OPENCLAW_STATE_DIR: previousStateDir,
    SANDBOX_REGISTRY_PATH: nodePath.join(baseDir, "containers.json"),
    SANDBOX_BROWSER_REGISTRY_PATH: nodePath.join(baseDir, "browsers.json"),
    SANDBOX_CONTAINERS_DIR: nodePath.join(baseDir, "containers"),
    SANDBOX_BROWSERS_DIR: nodePath.join(baseDir, "browsers"),
  };
});

vi.mock("../agents/sandbox/constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
}));

import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { hashTextSha256 } from "../agents/sandbox/hash.js";
import {
  readBrowserRegistry,
  readRegistry,
  readRegistryEntry,
  updateRegistry,
} from "../agents/sandbox/registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { migrateLegacySandboxRegistryFiles } from "./doctor-sandbox-legacy-registry.js";

type SandboxBrowserRegistryEntry =
  import("../agents/sandbox/registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("../agents/sandbox/registry.js").SandboxRegistryEntry;
type MigrationResult = Awaited<ReturnType<typeof migrateLegacySandboxRegistryFiles>>[number];

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
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
  } else {
    setTestEnvValue("OPENCLAW_STATE_DIR", PREVIOUS_OPENCLAW_STATE_DIR);
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

function seedRegistry(registryPath: string, entries: readonly unknown[]) {
  writeJsonFile(registryPath, { entries });
}

function seedShardedRegistry(dir: string, entries: readonly { containerName: string }[]) {
  for (const entry of entries) {
    writeJsonFile(path.join(dir, `${hashTextSha256(entry.containerName)}.json`), entry);
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

describe("legacy sandbox registry migration", () => {
  it("migrates legacy monolithic container and browser registry files after explicit repair", async () => {
    seedRegistry(SANDBOX_REGISTRY_PATH, [
      containerEntry({
        containerName: "legacy-container",
        sessionKey: "agent:legacy",
        lastUsedAtMs: 7,
        configHash: "legacy-container-hash",
      }),
    ]);
    seedRegistry(SANDBOX_BROWSER_REGISTRY_PATH, [
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
    expect(migrationResults).toEqual([
      { kind: "containers", status: "migrated", entries: 1 },
      { kind: "browsers", status: "migrated", entries: 1 },
    ]);

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
    expect(container?.configLabelKind).toBe("Image");
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
    seedShardedRegistry(SANDBOX_CONTAINERS_DIR, [
      containerEntry({
        containerName: "legacy-container",
        sessionKey: "agent:legacy",
        lastUsedAtMs: 7,
        configHash: "legacy-container-hash",
      }),
    ]);
    seedShardedRegistry(SANDBOX_BROWSERS_DIR, [
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
    seedRegistry(SANDBOX_REGISTRY_PATH, [
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
    seedRegistry(SANDBOX_REGISTRY_PATH, [
      containerEntry({
        containerName: "container-a",
        sessionKey: "legacy-session",
        lastUsedAtMs: 1,
      }),
    ]);
    seedShardedRegistry(SANDBOX_CONTAINERS_DIR, [
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

  it("quarantines malformed legacy registry files during migration", async () => {
    await fs.writeFile(SANDBOX_REGISTRY_PATH, "{bad json", "utf-8");
    await fs.writeFile(SANDBOX_BROWSER_REGISTRY_PATH, "{bad json", "utf-8");
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
    await fs.writeFile(SANDBOX_REGISTRY_PATH, invalidEntries, "utf-8");
    await fs.writeFile(SANDBOX_BROWSER_REGISTRY_PATH, invalidEntries, "utf-8");
    const migrationResults = await migrateLegacySandboxRegistryFiles();
    expect(requireMigrationResult(migrationResults, "containers").status).toBe(
      "quarantined-invalid",
    );
    expect(requireMigrationResult(migrationResults, "browsers").status).toBe("quarantined-invalid");
  });

  it("quarantines malformed sharded registry directories during migration", async () => {
    seedShardedRegistry(SANDBOX_CONTAINERS_DIR, [
      containerEntry({ containerName: "valid-container", sessionKey: "agent:valid" }),
    ]);
    seedShardedRegistry(SANDBOX_BROWSERS_DIR, [
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
