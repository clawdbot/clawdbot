import fs from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WriteDelayConfig = {
  targetFile: "containers.json" | "browsers.json";
  containerName: string;
  started: boolean;
  markStarted: () => void;
  waitForRelease: Promise<void>;
};

const { TEST_STATE_DIR, SANDBOX_REGISTRY_PATH, SANDBOX_BROWSER_REGISTRY_PATH, writeGateState } =
  vi.hoisted(() => {
    const path = require("node:path");
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));

    return {
      TEST_STATE_DIR: baseDir,
      SANDBOX_REGISTRY_PATH: path.join(baseDir, "containers.json"),
      SANDBOX_BROWSER_REGISTRY_PATH: path.join(baseDir, "browsers.json"),
      writeGateState: { active: null as WriteDelayConfig | null },
    };
  });

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
}));

vi.mock("../../infra/json-files.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/json-files.js")>(
    "../../infra/json-files.js",
  );
  return {
    ...actual,
    writeJsonAtomic: async (
      filePath: string,
      value: unknown,
      options?: Parameters<typeof actual.writeJsonAtomic>[2],
    ) => {
      const payload = JSON.stringify(value);
      const gate = writeGateState.active;
      if (
        gate &&
        filePath.includes(gate.targetFile) &&
        payloadMentionsContainer(payload, gate.containerName)
      ) {
        if (!gate.started) {
          gate.started = true;
          gate.markStarted();
        }
        await gate.waitForRelease;
      }
      await actual.writeJsonAtomic(filePath, value, options);
    },
  };
});

import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;

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
  targetFile: "containers.json" | "browsers.json",
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

describe("registry race safety", () => {
  it("normalizes legacy registry entries on read", async () => {
    await seedContainerRegistry([
      {
        containerName: "legacy-container",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:test",
      },
    ]);

    const registry = await readRegistry();
    expect(registry.entries).toEqual([
      expect.objectContaining({
        containerName: "legacy-container",
        backendId: "docker",
        runtimeLabel: "legacy-container",
        configLabelKind: "Image",
      }),
    ]);
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
    await seedContainerRegistry([containerEntry({ containerName: "container-x" })]);
    const writeGate = installWriteGate("containers.json", "container-x");

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
    await seedBrowserRegistry([browserEntry({ containerName: "browser-x" })]);
    const writeGate = installWriteGate("browsers.json", "browser-x");

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

  it("fails fast when registry files are malformed during update", async () => {
    await seedMalformedContainerRegistry("{bad json");
    await seedMalformedBrowserRegistry("{bad json");
    await expect(updateRegistry(containerEntry())).rejects.toThrow();
    await expect(updateBrowserRegistry(browserEntry())).rejects.toThrow();
  });

  it("fails fast when registry entries are invalid during update", async () => {
    const invalidEntries = `{"entries":[{"sessionKey":"agent:main"}]}`;
    await seedMalformedContainerRegistry(invalidEntries);
    await seedMalformedBrowserRegistry(invalidEntries);
    await expect(updateRegistry(containerEntry())).rejects.toThrow(
      /Invalid sandbox registry format/,
    );
    await expect(updateBrowserRegistry(browserEntry())).rejects.toThrow(
      /Invalid sandbox registry format/,
    );
  });
});
