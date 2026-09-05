// Doctor migration detection must stay independent of the broad security runtime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLegacyMigrationPreview } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";
import { detectWhatsAppLegacyStateMigrations } from "./state-migrations.js";

vi.mock("openclaw/plugin-sdk/security-runtime", () => {
  throw new Error("Doctor migration detection must not load the broad security runtime");
});

describe("WhatsApp legacy state migrations", () => {
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
      for (const file of [
        ...authFiles,
        "session-existing.json",
        "oauth.json",
        "google-oauth.json",
        "notes.txt",
      ]) {
        fs.writeFileSync(path.join(oauthDir, file), "{}", "utf-8");
      }
      fs.mkdirSync(path.join(oauthDir, "nested"));
      fs.writeFileSync(path.join(oauthDir, "nested", "session-keep.json"), "{}", "utf-8");
      fs.symlinkSync(path.join(oauthDir, "notes.txt"), path.join(oauthDir, "session-linked.json"));
      const targetDir = path.join(oauthDir, "whatsapp", "default");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "session-existing.json"), "{}", "utf-8");
      fs.symlinkSync(path.join(oauthDir, "notes.txt"), path.join(targetDir, "creds.json.bak"));
      fs.mkdirSync(path.join(targetDir, "pre-key-1.json"));

      const migrations = detectWhatsAppLegacyStateMigrations({ oauthDir });

      expect(migrations.map((migration) => path.basename(migration.sourcePath)).toSorted()).toEqual(
        authFiles.toSorted(),
      );
      expect(
        migrations
          .map((migration) => ({
            kind: migration.kind,
            label: migration.label,
            sourcePath: migration.sourcePath,
            targetPath: migration.targetPath,
            namespace: null,
          }))
          .toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
      ).toEqual(
        authFiles
          .map((fileName) => ({
            kind: "move",
            label: `WhatsApp auth ${fileName}`,
            sourcePath: path.join(oauthDir, fileName),
            targetPath: path.join(oauthDir, "whatsapp", "default", fileName),
            namespace: null,
          }))
          .toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
      );
      await expect(
        stateMigrations[0]?.detectLegacyState({
          config: {},
          env: {},
          oauthDir,
          stateDir: oauthDir,
          context: { openPluginStateKeyedStore: vi.fn() },
        }),
      ).resolves.toEqual({ preview: migrations.map(buildLegacyMigrationPreview) });
      for (const migration of migrations) {
        expect(migration.targetPath).toBe(
          path.join(oauthDir, "whatsapp", "default", path.basename(migration.sourcePath)),
        );
      }
    } finally {
      fs.rmSync(oauthDir, { recursive: true, force: true });
    }
  });
});
