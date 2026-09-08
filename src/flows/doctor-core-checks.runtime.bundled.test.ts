// Validate authored catalog rows and complete static provider configurations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { buildManifestModelProviderConfig } from "../plugin-sdk/provider-catalog-shared.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const extensionsDir = path.join(repoRoot, "extensions");

describe("doctor bundled provider catalog validation", () => {
  it("normalizes every catalog without dropping rows and validates static providers", () => {
    const errors: string[] = [];

    for (const extension of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!extension.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(extensionsDir, extension.name, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        id?: string;
        providers?: string[];
        modelCatalog?: { providers?: Record<string, unknown> };
      };
      const normalized = normalizeModelCatalog(manifest.modelCatalog, {
        ownedProviders: new Set(manifest.providers),
      });
      for (const [providerId, catalog] of Object.entries(manifest.modelCatalog?.providers ?? {})) {
        if (!manifest.providers?.includes(providerId)) {
          continue;
        }
        try {
          const rawModels = asOptionalRecord(catalog)?.models;
          const models = normalized?.providers?.[providerId]?.models;
          if (!Array.isArray(rawModels) || models?.length !== rawModels.length) {
            throw new Error("Manifest catalog normalization dropped a provider or model row");
          }
          // Runtime catalogs supply their own endpoints; only static catalogs
          // are converted directly into provider configurations by discovery.
          const discovery = normalized?.discovery?.[providerId];
          if (discovery !== "runtime" && discovery !== "refreshable") {
            buildManifestModelProviderConfig({ providerId, catalog });
          }
        } catch (error) {
          errors.push(`${manifest.id ?? extension.name}/${providerId}: ${String(error)}`);
        }
      }
    }

    expect(errors).toEqual([]);
  });
});
