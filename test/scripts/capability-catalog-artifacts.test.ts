import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import { collectSourceCheckoutPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { resolveAugmentedPluginNpmManifest } from "../../scripts/lib/plugin-npm-package-manifest.mts";
import { resolvePluginNpmRuntimeBuildPlan } from "../../scripts/lib/plugin-npm-runtime-build.mts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("capability catalog artifact ownership", () => {
  it.each(["esm", "cjs"] as const)(
    "carries nested declarations into %s build and emitted manifests",
    (runtimeFormat) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-artifacts-"));
      roots.push(root);
      const plugin = path.join(root, "extensions", "catalog-fixture");
      fs.mkdirSync(path.join(plugin, "catalog"), { recursive: true });
      const manifest = {
        id: "catalog-fixture",
        configSchema: { type: "object" },
        capabilityCatalogEntry: "./catalog/voice.ts",
        providerCatalogEntry: "./catalog/models.ts",
      };
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      fs.writeFileSync(
        path.join(plugin, "package.json"),
        JSON.stringify({
          name: "@openclaw/catalog-fixture",
          version: "2026.9.1",
          openclaw: {
            extensions: ["./index.ts"],
            release: { publishToNpm: true },
            build: { bundledDist: false, runtimeFormat },
          },
        }),
      );
      fs.writeFileSync(path.join(plugin, "openclaw.plugin.json"), JSON.stringify(manifest));
      for (const file of ["index.ts", "catalog/voice.ts", "catalog/models.ts"]) {
        fs.writeFileSync(path.join(plugin, file), "export default {};\n");
      }

      const [entry] = collectSourceCheckoutPluginBuildEntries({ cwd: root, env: {} });
      expect(entry?.sourceEntries).toEqual(
        expect.arrayContaining(["./catalog/voice.ts", "./catalog/models.ts"]),
      );
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot: root, packageDir: plugin })!;
      expect(plan.entry["catalog/voice"]).toBe(path.join(plugin, "catalog/voice.ts"));
      expect(plan.runtimeBuildOutputs).toContain(`./dist/catalog/voice${extension}`);
      expect(
        resolveAugmentedPluginNpmManifest({ repoRoot: root, packageDir: plugin }).manifest,
      ).toMatchObject({
        capabilityCatalogEntry: `./dist/catalog/voice${extension}`,
        providerCatalogEntry: `./dist/catalog/models${extension}`,
      });

      copyBundledPluginMetadata({ cwd: root, env: {} });
      const emitted = JSON.parse(
        fs.readFileSync(
          path.join(root, "dist", "extensions", "catalog-fixture", "openclaw.plugin.json"),
          "utf8",
        ),
      );
      expect(emitted).toMatchObject({
        capabilityCatalogEntry: `./catalog/voice${extension}`,
        providerCatalogEntry: `./catalog/models${extension}`,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(plugin, "openclaw.plugin.json"), "utf8")),
      ).toEqual(manifest);
    },
  );
});
