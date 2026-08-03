// Whatsapp tests cover setup entry plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as legacySessionSurfaceApi from "./legacy-session-surface-api.js";
import * as legacyStateMigrationsApi from "./legacy-state-migrations-api.js";
import setupEntry from "./setup-entry.js";
import * as setupPluginApi from "./setup-plugin-api.js";

vi.mock("baileys", () => {
  throw new Error("setup plugin load must not load Baileys");
});

vi.mock("./src/setup-finalize.js", () => {
  throw new Error("setup status load must not load finalize");
});

const setupEntryLoadOptions = {
  createLoaderForTest: (() => (specifier: string) => {
    if (/[\\/]setup-plugin-api\.[jt]s$/u.test(specifier)) {
      return setupPluginApi;
    }
    if (/[\\/]legacy-state-migrations-api\.[jt]s$/u.test(specifier)) {
      return legacyStateMigrationsApi;
    }
    if (/[\\/]legacy-session-surface-api\.[jt]s$/u.test(specifier)) {
      return legacySessionSurfaceApi;
    }
    throw new Error(`unexpected setup entry module load: ${specifier}`);
  }) as never,
};

describe("whatsapp setup entry", () => {
  it("loads setup entry metadata without importing runtime dependencies", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({
      legacySessionSurfaces: true,
      legacyStateMigrations: true,
    });
  });

  it("loads the setup plugin without installing runtime dependencies", () => {
    const whatsappSetupPlugin = setupEntry.loadSetupPlugin(setupEntryLoadOptions);
    expect(whatsappSetupPlugin.id).toBe("whatsapp");
  });

  it("loads legacy setup helpers without importing runtime dependencies", () => {
    const detectLegacyStateMigrations =
      setupEntry.loadLegacyStateMigrationDetector?.(setupEntryLoadOptions);
    if (!detectLegacyStateMigrations) {
      throw new Error("expected WhatsApp legacy state migration detector");
    }
    expect(
      detectLegacyStateMigrations({
        cfg: {},
        env: {},
        oauthDir: "/tmp/openclaw-whatsapp-empty",
        stateDir: "/tmp/openclaw-state",
      }),
    ).toStrictEqual([]);
    const legacySessionSurface = setupEntry.loadLegacySessionSurface?.(setupEntryLoadOptions);
    if (!legacySessionSurface) {
      throw new Error("expected WhatsApp legacy session surface");
    }
    expect(Object.keys(legacySessionSurface).toSorted()).toEqual([
      "canonicalizeLegacySessionKey",
      "isLegacyGroupSessionKey",
    ]);
    expect(legacySessionSurface.canonicalizeLegacySessionKey).toBeTypeOf("function");
    expect(legacySessionSurface.isLegacyGroupSessionKey).toBeTypeOf("function");
  });

  it("plans migration for every Baileys auth category while preserving other shared-root files", async () => {
    const oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-legacy-migration-"));
    const authFiles = [
      "creds.json",
      "creds.json.bak",
      "pre-key-1.json",
      "session-contact.json",
      "sender-key-group.json",
      "sender-key-memory-group.json",
      "app-state-sync-key-contact.json",
      "app-state-sync-version-contact.json",
      "lid-mapping-15551234567.json",
      "device-list-15551234567.json",
      "tctoken-15551234567.json",
      "identity-key-15551234567.json",
    ];

    try {
      for (const file of [...authFiles, "oauth.json", "google-oauth.json", "notes.txt"]) {
        fs.writeFileSync(path.join(oauthDir, file), "{}", "utf-8");
      }
      fs.mkdirSync(path.join(oauthDir, "nested"));
      fs.writeFileSync(path.join(oauthDir, "nested", "session-keep.json"), "{}", "utf-8");
      fs.symlinkSync(path.join(oauthDir, "notes.txt"), path.join(oauthDir, "session-linked.json"));

      const detectLegacyStateMigrations =
        setupEntry.loadLegacyStateMigrationDetector?.(setupEntryLoadOptions);
      if (!detectLegacyStateMigrations) {
        throw new Error("expected WhatsApp legacy state migration detector");
      }
      const migrations =
        (await detectLegacyStateMigrations({
          cfg: {},
          env: {},
          oauthDir,
          stateDir: oauthDir,
        })) ?? [];

      expect(migrations.map((migration) => path.basename(migration.sourcePath)).toSorted()).toEqual(
        authFiles.toSorted(),
      );
      for (const migration of migrations) {
        expect(migration.targetPath).toBe(
          path.join(oauthDir, "whatsapp", "default", path.basename(migration.sourcePath)),
        );
      }
    } finally {
      fs.rmSync(oauthDir, { recursive: true, force: true });
    }
  });

  it("loads the delegated setup wizard without importing runtime dependencies", async () => {
    const { whatsappSetupWizard } = await import("./src/setup-surface.js");

    expect(whatsappSetupWizard.channel).toBe("whatsapp");
  });
});
