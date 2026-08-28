// Guards the single-source contract for bundled channel config schemas.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";

type BundledManifest = {
  id?: string;
  channels?: string[];
  configSchema?: unknown;
  channelConfigs?: Record<string, { schema?: unknown }>;
};

function listBundledManifests(): Array<{ dirName: string; manifest: BundledManifest }> {
  const tracked =
    listGitTrackedFiles({ repoRoot, pathspecs: "extensions/*/openclaw.plugin.json" }) ?? [];
  return tracked.map((file) => ({
    dirName: file.split("/")[1] ?? file,
    manifest: JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as BundledManifest,
  }));
}

describe("bundled channel schema source", () => {
  it("keeps bundled channel schemas single-sourced from the generated metadata", () => {
    const generatedChannelIds = new Set(
      GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => entry.channelId),
    );
    // Channel plugins whose plugin-entry config is a real, distinct surface.
    const pluginEntryConfigExceptions = new Set(["whatsapp"]);
    const emptyStub = { type: "object", additionalProperties: false, properties: {} };
    const manifests = listBundledManifests();
    expect(manifests.length).toBeGreaterThan(0);
    for (const { dirName, manifest } of manifests) {
      const channelIds = (manifest.channels ?? []).filter((id) => generatedChannelIds.has(id));
      if (channelIds.length === 0) {
        continue;
      }
      for (const channelId of channelIds) {
        // A manifest copy silently overrides the zod-derived generated schema in
        // config validation and rots (stale copies rejected valid keys; see #131292).
        expect(
          manifest.channelConfigs?.[channelId]?.schema,
          `extensions/${dirName}: delete channelConfigs.${channelId}.schema — the zod-derived generated bundled channel metadata is the single schema source`,
        ).toBeUndefined();
      }
      if (!pluginEntryConfigExceptions.has(manifest.id ?? dirName)) {
        expect(
          manifest.configSchema,
          `extensions/${dirName}: channel plugins carry no plugin-entry config; keep configSchema as the empty stub or add a named exception here with its reason`,
        ).toEqual(emptyStub);
      }
    }
  });
});
