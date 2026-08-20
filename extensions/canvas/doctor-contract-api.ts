// Canvas doctor contract migrates documents from configured host roots into core storage.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import {
  asOptionalRecord as readRecord,
  readStringValue as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { migrateCanvasHostConfig } from "./src/config-migration.js";

const RETIRED_CANVAS_HOST_CONFIG_PATH = ["plugins", "entries", "canvas", "config", "host"] as const;

/** Retired Canvas file-host settings detected before strict plugin validation. */
export const legacyConfigRules = [
  {
    path: ["canvasHost"],
    message:
      'canvasHost is retired; only plugins.entries.canvas.config.host.enabled remains. Run "openclaw doctor --fix".',
  },
  ...(["root", "port", "liveReload"] as const).map((key) => ({
    path: [...RETIRED_CANVAS_HOST_CONFIG_PATH, key],
    message: `${[...RETIRED_CANVAS_HOST_CONFIG_PATH, key].join(".")} is retired. Run "openclaw doctor --fix".`,
  })),
];

/** Removes retired file-host config while preserving the surviving enablement switch. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return migrateCanvasHostConfig(cfg) ?? { config: cfg, changes: [] };
}

type StateMigrationParams = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

function resolveLegacyDocumentsDir(params: StateMigrationParams): string | null {
  const pluginConfig = resolvePluginConfigObject(params.config, "canvas");
  const configuredRoot = readString(readRecord(pluginConfig?.host)?.root)?.trim();
  if (!configuredRoot) {
    return null;
  }
  const legacyDir = path.join(
    path.resolve(resolveUserPath(configuredRoot, params.env)),
    "documents",
  );
  const coreDir = path.resolve(params.stateDir, "canvas", "documents");
  return legacyDir === coreDir ? null : legacyDir;
}

async function listDocumentIds(documentsDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(documentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "canvas-custom-root-documents-to-core",
    label: "Canvas documents in a custom host root",
    async detectLegacyState(params) {
      const legacyDir = resolveLegacyDocumentsDir(params);
      if (!legacyDir) {
        return null;
      }
      const documentIds = await listDocumentIds(legacyDir);
      if (documentIds.length === 0) {
        return null;
      }
      const coreDir = path.resolve(params.stateDir, "canvas", "documents");
      return {
        preview: [
          `- Canvas documents: ${legacyDir} -> ${coreDir} (${documentIds.length} document(s))`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const legacyDir = resolveLegacyDocumentsDir(params);
      if (!legacyDir) {
        return { changes, warnings };
      }
      const documentIds = await listDocumentIds(legacyDir);
      if (documentIds.length === 0) {
        return { changes, warnings };
      }

      const coreDir = path.resolve(params.stateDir, "canvas", "documents");
      await fs.mkdir(coreDir, { recursive: true });
      let migrated = 0;
      for (const documentId of documentIds) {
        const sourceDir = path.join(legacyDir, documentId);
        const targetDir = path.join(coreDir, documentId);
        let tempParent: string | undefined;
        try {
          if (await pathExists(targetDir)) {
            throw new Error("core target already exists");
          }
          tempParent = await fs.mkdtemp(path.join(coreDir, ".canvas-migrate-"));
          const tempDocumentDir = path.join(tempParent, documentId);
          await fs.cp(sourceDir, tempDocumentDir, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          if (await pathExists(targetDir)) {
            throw new Error("core target was created during migration");
          }
          // Publish only a complete same-filesystem copy; interrupted copies stay invisible.
          await fs.rename(tempDocumentDir, targetDir);
          await fs.rm(sourceDir, { recursive: true, force: true });
          migrated += 1;
        } catch (error) {
          warnings.push(
            `Skipped Canvas document ${documentId}; core target may already exist: ${String(error)}`,
          );
        } finally {
          if (tempParent) {
            await fs.rm(tempParent, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
      if (migrated > 0) {
        changes.push(`Migrated ${migrated} Canvas document(s) into core storage`);
      }
      try {
        if ((await fs.readdir(legacyDir)).length === 0) {
          await fs.rmdir(legacyDir);
        }
      } catch {
        // A retained or concurrently created document keeps the legacy directory in place.
      }
      return { changes, warnings };
    },
  },
];
