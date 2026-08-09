// Sandbox registry tests cover SQLite ordering and race safety for container/browser runtime records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { TEST_STATE_DIR, PREVIOUS_OPENCLAW_STATE_DIR, SANDBOX_REGISTRY_PATH } = vi.hoisted(() => {
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
  };
});

import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import {
  readBrowserRegistry,
  readRegisteredSandboxRuntimeIds,
  readRegistry,
  readRegistryEntry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(path.join(TEST_STATE_DIR, "state"), { recursive: true, force: true });
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
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

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected ${targetPath} to be missing`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    expect(code).toBe("ENOENT");
  }
}

describe("registry race safety", () => {
  it("does not migrate legacy registry files from runtime reads", async () => {
    // Runtime reads should ignore old monolithic files; explicit doctor/repair
    // owns migration so normal startup cannot mutate registry layout.
    const legacyEntry = containerEntry({ containerName: "legacy-container" });
    await fs.writeFile(
      SANDBOX_REGISTRY_PATH,
      `${JSON.stringify({ entries: [legacyEntry] }, null, 2)}\n`,
      "utf-8",
    );

    await expect(readRegistry()).resolves.toEqual({ entries: [] });
    await expect(readRegistryEntry("legacy-container")).resolves.toBeNull();
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).resolves.toBeUndefined();
    await expectPathMissing(path.join(TEST_STATE_DIR, "state", "openclaw.sqlite"));
  });

  it("reads a single SQLite entry without scanning the full registry", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x", sessionKey: "sess:x" }));
    await updateRegistry(containerEntry({ containerName: "container-y", sessionKey: "sess:y" }));

    const entry = await readRegistryEntry("container-x");
    expect(entry?.containerName).toBe("container-x");
    expect(entry?.sessionKey).toBe("sess:x");
    await expect(readRegistryEntry("missing-container")).resolves.toBeNull();
  });

  it("preserves a Podman target across registry usage updates", async () => {
    await updateRegistry(
      containerEntry({
        backendId: "podman",
        backendTarget: {
          key: "machine:target-a",
          globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
        },
      }),
    );
    await updateRegistry(
      containerEntry({
        backendId: "podman",
        lastUsedAtMs: 2,
      }),
    );

    await expect(readRegistryEntry("container-a")).resolves.toMatchObject({
      backendId: "podman",
      backendTarget: {
        key: "machine:target-a",
        globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
      },
      lastUsedAtMs: 2,
    });
  });

  it("reads registered runtime IDs for one backend and scope newest first", async () => {
    await updateRegistry(
      containerEntry({
        containerName: "openshell-older",
        backendId: "openshell",
        sessionKey: "agent:main",
        lastUsedAtMs: 10,
      }),
    );
    await updateRegistry(
      containerEntry({
        containerName: "openshell-newer",
        backendId: "openshell",
        sessionKey: "agent:main",
        lastUsedAtMs: 20,
      }),
    );
    await updateRegistry(
      containerEntry({
        containerName: "docker-same-scope",
        backendId: "docker",
        sessionKey: "agent:main",
        lastUsedAtMs: 30,
      }),
    );
    await updateRegistry(
      containerEntry({
        containerName: "openshell-other-scope",
        backendId: "openshell",
        sessionKey: "agent:other",
        lastUsedAtMs: 40,
      }),
    );

    await expect(
      readRegisteredSandboxRuntimeIds({
        backendId: "openshell",
        scopeKey: "agent:main",
      }),
    ).resolves.toEqual(["openshell-newer", "openshell-older"]);
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
});
