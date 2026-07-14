// Setup migration import tests cover importing existing config into onboarding.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { listSetupMigrationOptions } from "./setup.migration-import.js";
import {
  inspectSetupMigrationFreshness,
  preserveSetupMigrationSecurityAcknowledgement,
} from "./setup.migration-snapshot.js";

const tempRoots = new Set<string>();

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-migration-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("setup migration import freshness", () => {
  afterEach(async () => {
    for (const root of tempRoots) {
      await fs.rm(root, { force: true, recursive: true });
    }
    tempRoots.clear();
  });

  it("allows empty config and empty target directories", async () => {
    const root = await makeTempRoot();
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {},
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("allows the first-launch security acknowledgement before import", async () => {
    const root = await makeTempRoot();
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
      },
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("preserves the first-launch acknowledgement across the lock-time config reread", () => {
    expect(
      preserveSetupMigrationSecurityAcknowledgement(
        {},
        { wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" } },
      ),
    ).toEqual({ wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" } });
  });

  it("rejects other wizard config during import freshness checks", async () => {
    const root = await makeTempRoot();
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {
        wizard: {
          securityAcknowledgedAt: "2026-06-30T00:00:00.000Z",
          lastRunMode: "local",
        },
      },
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result.fresh).toBe(false);
    expect(result.reasons).toEqual(["existing config values are loaded"]);
  });

  it("rejects existing config, workspace files, and state", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "existing memory\n");
    await writeFile(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), "{}\n");

    const result = await inspectSetupMigrationFreshness({
      baseConfig: { gateway: { port: 3131 } },
      stateDir,
      workspaceDir,
    });

    expect(result.fresh).toBe(false);
    expect(result.reasons).toEqual([
      "existing config values are loaded",
      "workspace MEMORY.md exists",
      "state agents/ exists",
    ]);
  });
});

describe("setup migration import options", () => {
  let initialOptions: Awaited<ReturnType<typeof listSetupMigrationOptions>>;

  beforeAll(async () => {
    initialOptions = await listSetupMigrationOptions({
      baseConfig: {},
      detections: [],
    });
  });

  it("offers bundled manifest migration providers before plugin activation", () => {
    expect(initialOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "codex", label: "Codex" }),
        expect.objectContaining({ providerId: "claude", label: "Claude" }),
        expect.objectContaining({ providerId: "hermes", label: "Hermes" }),
      ]),
    );
  });

  it("offers official installable Codex when bundled plugins are unavailable", async () => {
    const previousDisableBundled = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    const previousDisablePersisted = process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = "1";
    try {
      const options = await listSetupMigrationOptions({
        baseConfig: {},
        detections: [],
      });

      expect(options).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerId: "codex", label: "Codex" })]),
      );
    } finally {
      if (previousDisableBundled === undefined) {
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      } else {
        process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundled;
      }
      if (previousDisablePersisted === undefined) {
        delete process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY;
      } else {
        process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = previousDisablePersisted;
      }
    }
  });
});
