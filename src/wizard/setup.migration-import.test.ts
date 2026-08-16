// Setup migration import tests cover importing existing config into onboarding.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listSetupMigrationOptions } from "./setup.migration-import.js";
import {
  assertFreshSetupMigrationTarget,
  buildSetupMigrationTargetSnapshot,
  inspectSetupMigrationFreshness,
  preserveSetupMigrationSecurityAcknowledgement,
} from "./setup.migration-snapshot.js";

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("setup migration import freshness", () => {
  const tempRoots = useAutoCleanupTempDirTracker(afterEach);

  it("allows empty config and empty target directories", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {},
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("allows the first-launch security acknowledgement before import", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
      },
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("allows runtime-only state scaffolding before import", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(stateDir, "state", "openclaw.sqlite"), "runtime database\n");
    await writeFile(path.join(stateDir, "tmp", "startup"), "runtime scratch\n");

    const result = await inspectSetupMigrationFreshness({
      baseConfig: {},
      stateDir,
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("ignores runtime state churn while still detecting workspace changes", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const initial = await buildSetupMigrationTargetSnapshot({
      config: {},
      stateDir,
      workspaceDir,
    });

    await writeFile(path.join(stateDir, "state", "openclaw.sqlite"), "runtime database\n");
    expect(await buildSetupMigrationTargetSnapshot({ config: {}, stateDir, workspaceDir })).toBe(
      initial,
    );

    await writeFile(path.join(workspaceDir, "external.txt"), "concurrent write\n");
    expect(
      await buildSetupMigrationTargetSnapshot({ config: {}, stateDir, workspaceDir }),
    ).not.toBe(initial);
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
    const root = tempRoots.make("openclaw-setup-migration-");
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

  it("rejects existing config, workspace files, credentials, sessions, and agents", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "existing memory\n");
    await writeFile(path.join(stateDir, "credentials", "provider.json"), "{}\n");
    await writeFile(path.join(stateDir, "sessions", "session.json"), "{}\n");
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
      "state credentials/ exists",
      "state sessions/ exists",
      "state agents/ exists",
    ]);
    expect(() => assertFreshSetupMigrationTarget(result)).toThrow(
      "Migration import during onboarding requires a fresh OpenClaw setup.",
    );
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

  it("does not offer install-only providers during a transactional import", async () => {
    const previousDisableBundled = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    try {
      const options = await listSetupMigrationOptions({
        baseConfig: {},
        detections: [],
      });

      expect(options).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ providerId: "codex" })]),
      );
    } finally {
      if (previousDisableBundled === undefined) {
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      } else {
        process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundled;
      }
    }
  });
});
