import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

const tempDirs: string[] = [];
const migration = stateMigrations[0];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), label));
  tempDirs.push(dir);
  return dir;
}

function migrationParams(params: {
  stateDir: string;
  customRoot?: string;
}): Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0] {
  const config = params.customRoot
    ? ({
        plugins: {
          entries: {
            canvas: { config: { host: { root: params.customRoot } } },
          },
        },
      } as OpenClawConfig)
    : ({} as OpenClawConfig);
  return {
    config,
    env: process.env,
    stateDir: params.stateDir,
    oauthDir: path.join(params.stateDir, "credentials"),
    context: { openPluginStateKeyedStore: () => undefined as never },
  };
}

describe("Canvas doctor state migration", () => {
  it("ignores the default core document root", async () => {
    const stateDir = await createTempDir("openclaw-canvas-doctor-state-");
    await fs.mkdir(path.join(stateDir, "canvas", "documents", "cv_default"), {
      recursive: true,
    });

    await expect(migration?.detectLegacyState(migrationParams({ stateDir }))).resolves.toBeNull();
  });

  it("moves custom-root documents into the stable core layout", async () => {
    const stateDir = await createTempDir("openclaw-canvas-doctor-state-");
    const customRoot = await createTempDir("openclaw-canvas-doctor-custom-");
    const legacyDocumentDir = path.join(customRoot, "documents", "cv_existing");
    await fs.mkdir(path.join(legacyDocumentDir, "collection.media"), { recursive: true });
    await fs.writeFile(path.join(legacyDocumentDir, "index.html"), "<p>existing</p>", "utf8");
    await fs.writeFile(
      path.join(legacyDocumentDir, "collection.media", "asset.txt"),
      "asset",
      "utf8",
    );
    const params = migrationParams({ stateDir, customRoot });

    await expect(migration?.detectLegacyState(params)).resolves.toEqual({
      preview: [
        `- Canvas documents: ${path.join(customRoot, "documents")} -> ${path.join(stateDir, "canvas", "documents")} (1 document(s))`,
      ],
    });
    const result = await migration?.migrateLegacyState(params);

    expect(result).toEqual({
      changes: ["Migrated 1 Canvas document(s) into core storage"],
      warnings: [],
    });
    await expect(
      fs.readFile(path.join(stateDir, "canvas", "documents", "cv_existing", "index.html"), "utf8"),
    ).resolves.toBe("<p>existing</p>");
    await expect(
      fs.readFile(
        path.join(stateDir, "canvas", "documents", "cv_existing", "collection.media", "asset.txt"),
        "utf8",
      ),
    ).resolves.toBe("asset");
    await expect(fs.access(legacyDocumentDir)).rejects.toThrow();
  });

  it("leaves a conflicting legacy document in place", async () => {
    const stateDir = await createTempDir("openclaw-canvas-doctor-state-");
    const customRoot = await createTempDir("openclaw-canvas-doctor-custom-");
    const legacyDocumentDir = path.join(customRoot, "documents", "cv_conflict");
    const coreDocumentDir = path.join(stateDir, "canvas", "documents", "cv_conflict");
    await fs.mkdir(legacyDocumentDir, { recursive: true });
    await fs.mkdir(coreDocumentDir, { recursive: true });
    await fs.writeFile(path.join(legacyDocumentDir, "index.html"), "legacy", "utf8");
    await fs.writeFile(path.join(coreDocumentDir, "index.html"), "core", "utf8");

    const result = await migration?.migrateLegacyState(migrationParams({ stateDir, customRoot }));

    expect(result?.changes).toEqual([]);
    expect(result?.warnings).toHaveLength(1);
    await expect(fs.readFile(path.join(legacyDocumentDir, "index.html"), "utf8")).resolves.toBe(
      "legacy",
    );
    await expect(fs.readFile(path.join(coreDocumentDir, "index.html"), "utf8")).resolves.toBe(
      "core",
    );
  });

  it("cleans partial copies and retries the migration", async () => {
    const stateDir = await createTempDir("openclaw-canvas-doctor-state-");
    const customRoot = await createTempDir("openclaw-canvas-doctor-custom-");
    const legacyDocumentDir = path.join(customRoot, "documents", "cv_retry");
    const coreDocumentsDir = path.join(stateDir, "canvas", "documents");
    const coreDocumentDir = path.join(coreDocumentsDir, "cv_retry");
    await fs.mkdir(legacyDocumentDir, { recursive: true });
    await fs.writeFile(path.join(legacyDocumentDir, "index.html"), "complete", "utf8");
    const params = migrationParams({ stateDir, customRoot });
    const copy = vi.spyOn(fs, "cp").mockImplementationOnce(async (_source, destination) => {
      const destinationPath =
        typeof destination === "string" ? destination : fileURLToPath(destination);
      await fs.mkdir(destinationPath, { recursive: true });
      await fs.writeFile(path.join(destinationPath, "index.html"), "partial", "utf8");
      throw new Error("interrupted copy");
    });

    const failed = await migration?.migrateLegacyState(params);

    expect(failed?.changes).toEqual([]);
    expect(failed?.warnings).toHaveLength(1);
    await expect(fs.access(coreDocumentDir)).rejects.toThrow();
    await expect(fs.readFile(path.join(legacyDocumentDir, "index.html"), "utf8")).resolves.toBe(
      "complete",
    );
    expect(
      (await fs.readdir(coreDocumentsDir)).filter((name) => name.startsWith(".canvas-migrate-")),
    ).toEqual([]);

    copy.mockRestore();
    await expect(migration?.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated 1 Canvas document(s) into core storage"],
      warnings: [],
    });
    await expect(fs.readFile(path.join(coreDocumentDir, "index.html"), "utf8")).resolves.toBe(
      "complete",
    );
  });
});
