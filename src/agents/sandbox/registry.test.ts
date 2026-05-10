import fs from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WriteDelayConfig = {
  targetFile: "containers.json" | "browsers.json" | null;
  containerName: string;
  started: boolean;
  markStarted: () => void;
  waitForRelease: Promise<void>;
};

const {
  TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
  writeGateState,
} = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));

  return {
    TEST_STATE_DIR: baseDir,
    SANDBOX_REGISTRY_PATH: path.join(baseDir, "containers.json"),
    SANDBOX_BROWSER_REGISTRY_PATH: path.join(baseDir, "browsers.json"),
    SANDBOX_CONTAINERS_DIR: path.join(baseDir, "containers"),
    SANDBOX_BROWSERS_DIR: path.join(baseDir, "browsers"),
    writeGateState: { active: null as WriteDelayConfig | null },
  };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
}));

vi.mock("../../infra/json-files.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/json-files.js")>(
    "../../infra/json-files.js",
  );
  return {
    ...actual,
    writeJson: async (
      filePath: string,
      value: unknown,
      options?: Parameters<typeof actual.writeJson>[2],
    ) => {
      const payload = JSON.stringify(value);
      const gate = writeGateState.active;
      if (
        gate &&
        (!gate.targetFile || filePath.includes(gate.targetFile)) &&
        payloadMentionsContainer(payload, gate.containerName)
      ) {
        if (!gate.started) {
          gate.started = true;
          gate.markStarted();
        }
        await gate.waitForRelease;
      }
      await actual.writeJson(filePath, value, options);
    },
  };
});

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

function payloadMentionsContainer(payload: string, containerName: string): boolean {
  return (
    payload.includes(`"containerName":"${containerName}"`) ||
    payload.includes(`"containerName": "${containerName}"`)
  );
}

async function seedMalformedContainerRegistry(payload: string) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, payload, "utf-8");
}

async function seedMalformedBrowserRegistry(payload: string) {
  await fs.writeFile(SANDBOX_BROWSER_REGISTRY_PATH, payload, "utf-8");
}

function installWriteGate(
  targetFile: "containers.json" | "browsers.json" | null,
  containerName: string,
): { waitForStart: Promise<void>; release: () => void } {
  let markStarted = () => {};
  const waitForStart = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let resolveRelease = () => {};
  const waitForRelease = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  writeGateState.active = {
    targetFile,
    containerName,
    started: false,
    markStarted,
    waitForRelease,
  };
  return {
    waitForStart,
    release: () => {
      resolveRelease();
      writeGateState.active = null;
    },
  };
}

beforeEach(() => {
  writeGateState.active = null;
});

afterEach(async () => {
  await fs.rm(SANDBOX_CONTAINERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_BROWSERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
  await fs.rm(SANDBOX_BROWSER_REGISTRY_PATH, { force: true });
  await fs.rm(`${SANDBOX_REGISTRY_PATH}.lock`, { force: true });
  await fs.rm(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`, { force: true });
});

afterAll(async () => {
  await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
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

  it("migrates legacy container and browser registry files after explicit repair", async () => {
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

  it("does not overwrite newer sharded entries during legacy migration", async () => {
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

  it("reads a single sharded entry without scanning the full registry", async () => {
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
    const writeGate = installWriteGate(null, "container-x");

    const updatePromise = updateRegistry(
      containerEntry({ containerName: "container-x", configHash: "updated" }),
    );
    await writeGate.waitForStart;
    const removePromise = removeRegistryEntry("container-x");
    writeGate.release();
    await Promise.all([updatePromise, removePromise]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("stores unsafe container names as encoded shard filenames", async () => {
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
    const writeGate = installWriteGate(null, "browser-x");

    const updatePromise = updateBrowserRegistry(
      browserEntry({ containerName: "browser-x", configHash: "updated" }),
    );
    await writeGate.waitForStart;
    const removePromise = removeBrowserRegistryEntry("browser-x");
    writeGate.release();
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
});
