// Shared upstream model contract tests keep capability flags aligned across bundled catalogs.
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const MANIFEST_BASENAME = "openclaw.plugin.json";
const CODE_MODE_TIER_LITERAL = /codeMode:\s*"(?:preferred|capable)"/;
// Catalogs still built in plugin source instead of `modelCatalog` manifest rows,
// so the manifest scan below cannot see their tiers. Moving them is not free:
// `google` rows would newly feed model visibility and pre-discovery thinking
// metadata through `loadManifestModelCatalog`, and `minimax` resolves cost per
// provider surface, so its rows cannot live in one manifest catalog.
const UNCONVERTED_SOURCE_CATALOG_PLUGINS = ["google", "minimax"];

type CatalogEntry = {
  /** `provider/model` ref used in failure output. */
  ref: string;
  /** Shared-model group: the normalized upstream model id, else the row's own. */
  groupKey: string;
  /** Declared upstream ref, present only on non-canonical rows. */
  upstreamModel?: string;
  /** Declared code-mode tier; absent rows fall back to the implicit `capable` tier. */
  codeMode?: string;
};

function listBundledPluginFiles(): string[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" });
  if (!files) {
    throw new Error("unable to list bundled plugin files from git");
  }
  return files;
}

function readBundledManifests(): Array<Record<string, unknown>> {
  return listBundledPluginFiles()
    .filter((file) => {
      const segments = file.split("/");
      return segments.length === 3 && segments[2] === MANIFEST_BASENAME;
    })
    .map(
      (file) =>
        JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as Record<string, unknown>,
    );
}

/**
 * Reduces a catalog model id to the vendor's own name for the weights.
 * Aggregators republish first-party models under a namespaced id and varying
 * case (`moonshotai/kimi-k3`, `zai-org/GLM-5.2`), so dropping one leading
 * namespace segment groups those with the first-party row automatically instead
 * of waiting for someone to declare `upstreamModel` on each one.
 */
function normalizeSharedModelId(modelId: string): string {
  const separator = modelId.indexOf("/");
  return (separator === -1 ? modelId : modelId.slice(separator + 1)).toLowerCase();
}

function collectCatalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const manifest of readBundledManifests()) {
    const providers = readRecord(readRecord(manifest.modelCatalog)?.providers) ?? {};
    // CLI backends run their own harness, so catalog code-mode tiers never reach them.
    const cliBackends = new Set(
      Array.isArray(manifest.cliBackends) ? (manifest.cliBackends as string[]) : [],
    );
    for (const [providerId, provider] of Object.entries(providers)) {
      if (cliBackends.has(providerId)) {
        continue;
      }
      const models = readRecord(provider)?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const rawModel of models) {
        const model = readRecord(rawModel);
        const id = typeof model?.id === "string" ? model.id : undefined;
        if (!id) {
          continue;
        }
        const upstreamModel =
          typeof model?.upstreamModel === "string" ? model.upstreamModel : undefined;
        const codeMode = readRecord(model?.compat)?.codeMode;
        entries.push({
          ref: `${providerId}/${id}`,
          groupKey: normalizeSharedModelId(
            upstreamModel ? upstreamModel.slice(upstreamModel.indexOf("/") + 1) : id,
          ),
          ...(upstreamModel ? { upstreamModel } : {}),
          ...(typeof codeMode === "string" ? { codeMode } : {}),
        });
      }
    }
  }
  return entries;
}

function groupBySharedModel(entries: CatalogEntry[]): Map<string, CatalogEntry[]> {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.groupKey);
    if (group) {
      group.push(entry);
      continue;
    }
    groups.set(entry.groupKey, [entry]);
  }
  return groups;
}

describe("bundled shared upstream model catalogs", () => {
  // Read lazily: the non-isolated contract runner shares one process, so manifest
  // IO belongs inside the tests rather than in collection.
  let cached: CatalogEntry[] | undefined;
  const readEntries = (): CatalogEntry[] => (cached ??= collectCatalogEntries());

  it("resolves every declared upstream model ref to another bundled catalog row", () => {
    const entries = readEntries();
    const refs = new Set(entries.map((entry) => entry.ref));
    const unresolved = entries
      .filter((entry) => entry.upstreamModel)
      .filter((entry) => entry.upstreamModel === entry.ref || !refs.has(entry.upstreamModel ?? ""))
      .map((entry) => `${entry.ref} -> ${entry.upstreamModel}`)
      .toSorted();

    expect(unresolved).toEqual([]);
  });

  it("declares the code-mode tier on every catalog row that ships a shared model", () => {
    // `compat.codeMode` gates `tools.codeMode: "auto"` per model, so one catalog
    // flagging a model `preferred` while a sibling catalog for the same upstream
    // model stays silent makes the identical model behave differently by provider.
    const silent: string[] = [];
    for (const [groupKey, group] of groupBySharedModel(readEntries())) {
      if (group.length < 2 || !group.some((entry) => entry.codeMode)) {
        continue;
      }
      const declared = group
        .filter((entry) => entry.codeMode)
        .map((entry) => `${entry.ref}=${entry.codeMode}`)
        .toSorted()
        .join(", ");
      for (const entry of group.filter((candidate) => !candidate.codeMode)) {
        silent.push(`${entry.ref} (shared model ${groupKey}; siblings declare ${declared})`);
      }
    }

    expect(silent.toSorted()).toEqual([]);
  });

  it("keeps code-mode tiers out of plugin source so shared-model checks can see them", () => {
    const plugins = listBundledPluginFiles()
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .filter((file) =>
        CODE_MODE_TIER_LITERAL.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
      )
      .map((file) => file.split("/")[1] as string);

    expect([...new Set(plugins)].toSorted()).toEqual(UNCONVERTED_SOURCE_CATALOG_PLUGINS);
  });
});
