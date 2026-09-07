import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  CONTROL_UI_ASSET_MANIFEST_FILENAME,
  CONTROL_UI_ASSET_MANIFEST_VERSION,
  hashControlUiAssetManifestEntries,
  type ControlUiAssetManifestEntry,
} from "./control-ui-asset-manifest.js";

export function createRetentionManifest(entries: ControlUiAssetManifestEntry[]) {
  const assets = entries.toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    version: CONTROL_UI_ASSET_MANIFEST_VERSION,
    generation: hashControlUiAssetManifestEntries(assets),
    assets,
  };
}

export async function writeRetentionBuild(
  root: string,
  label: string,
  options: { size?: number; corrupt?: boolean; assetPath?: string } = {},
) {
  const assetPath = options.assetPath ?? `assets/panel-${label}.js`;
  const contents =
    options.size === undefined
      ? Buffer.from(`export const panel = ${JSON.stringify(label)};\n`)
      : Buffer.alloc(options.size, label.charCodeAt(0));
  await fs.mkdir(path.dirname(path.join(root, assetPath)), { recursive: true });
  await fs.writeFile(path.join(root, assetPath), contents);
  const manifest = createRetentionManifest([
    {
      path: assetPath,
      sha256: options.corrupt
        ? "0".repeat(64)
        : createHash("sha256").update(contents).digest("hex"),
      size: contents.byteLength,
    },
  ]);
  await fs.writeFile(
    path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME),
    `${JSON.stringify(manifest)}\n`,
  );
  return { root, assetPath, manifest };
}

export async function withRetentionFixture(
  run: (fixture: {
    root: string;
    cache: string;
    seed: (
      label: string,
      options?: Parameters<typeof writeRetentionBuild>[2],
    ) => Promise<Awaited<ReturnType<typeof writeRetentionBuild>> & { target: string }>;
  }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retention-")));
  const state = path.join(root, "state");
  const cache = path.join(state, "cache", "control-ui-assets");
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: state }, async () => {
      await fs.mkdir(cache, { recursive: true });
      await run({
        root,
        cache,
        seed: async (label, options) => {
          const build = await writeRetentionBuild(
            path.join(root, `build-${label}`),
            label,
            options,
          );
          const target = path.join(cache, build.manifest.generation);
          await fs.cp(build.root, target, { recursive: true });
          await fs.utimes(target, 1_700_000_000, 1_700_000_000);
          return { ...build, target };
        },
      });
    });
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
}
