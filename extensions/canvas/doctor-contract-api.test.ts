import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

const migration = stateMigrations[0];
const canvasDoctorWorkspaceRoot = resolvePreferredOpenClawTmpDir();

function createCanvasDoctorWorkspace(kind: "state" | "custom") {
  return tempWorkspace({
    rootDir: canvasDoctorWorkspaceRoot,
    prefix: `openclaw-canvas-doctor-${kind}-`,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
    await using stateWorkspace = await createCanvasDoctorWorkspace("state");
    const stateDir = stateWorkspace.dir;
    await fs.mkdir(path.join(stateDir, "canvas", "documents", "cv_default"), {
      recursive: true,
    });

    await expect(migration?.detectLegacyState(migrationParams({ stateDir }))).resolves.toBeNull();
  });

  it("moves custom-root documents into the stable core layout", async () => {
    await using stateWorkspace = await createCanvasDoctorWorkspace("state");
    await using customWorkspace = await createCanvasDoctorWorkspace("custom");
    const stateDir = stateWorkspace.dir;
    const customRoot = customWorkspace.dir;
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
    await using stateWorkspace = await createCanvasDoctorWorkspace("state");
    await using customWorkspace = await createCanvasDoctorWorkspace("custom");
    const stateDir = stateWorkspace.dir;
    const customRoot = customWorkspace.dir;
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
    await using stateWorkspace = await createCanvasDoctorWorkspace("state");
    await using customWorkspace = await createCanvasDoctorWorkspace("custom");
    const stateDir = stateWorkspace.dir;
    const customRoot = customWorkspace.dir;
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
