// Doctor bundled provider tests ensure every shipped manifest catalog projects into runtime rows.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifestModelProviderConfig } from "../plugin-sdk/provider-catalog-shared.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const extensionsDir = path.join(repoRoot, "extensions");

describe("doctor bundled provider catalog validation", () => {
  it("accepts every bundled manifest provider catalog", () => {
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
      for (const [providerId, catalog] of Object.entries(manifest.modelCatalog?.providers ?? {})) {
        if (!manifest.providers?.includes(providerId)) {
          continue;
        }
        try {
          buildManifestModelProviderConfig({ providerId, catalog });
        } catch (error) {
          errors.push(`${manifest.id ?? extension.name}/${providerId}: ${String(error)}`);
        }
      }
    }

    expect(errors).toEqual([]);
  });
});
