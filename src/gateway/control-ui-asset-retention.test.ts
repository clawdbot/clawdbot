import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  CONTROL_UI_ASSET_MANIFEST_FILENAME,
  CONTROL_UI_ASSET_MANIFEST_VERSION,
  hashControlUiAssetManifestEntries,
  type ControlUiAssetManifestEntry,
} from "./control-ui-asset-manifest.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";

function createControlUiAssetManifest(entries: ControlUiAssetManifestEntry[]) {
  const assets = entries.toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    version: CONTROL_UI_ASSET_MANIFEST_VERSION,
    generation: hashControlUiAssetManifestEntries(assets),
    assets,
  };
}

async function writeBuild(root: string, label: string, corrupt = false): Promise<string> {
  const assetPath = `assets/panel-${label}.js`;
  const contents = Buffer.from(`export const panel = ${JSON.stringify(label)};\n`);
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, assetPath), contents);
  const manifest = createControlUiAssetManifest([
    {
      path: assetPath,
      sha256: corrupt ? "0".repeat(64) : createHash("sha256").update(contents).digest("hex"),
      size: contents.byteLength,
    },
  ]);
  await fs.writeFile(
    path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME),
    `${JSON.stringify(manifest)}\n`,
  );
  return assetPath;
}

describe("Control UI asset retention", () => {
  it("keeps the current and two prior verified generations", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-retention-"));
    const stateDir = path.join(fixture, "state");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const builds: Array<{ assetPath: string; root: string }> = [];
        for (const label of ["a", "b", "c", "d"]) {
          const root = path.join(fixture, `build-${label}`);
          const assetPath = await writeBuild(root, label);
          const retention = createControlUiAssetRetention(root);
          await retention.prepare();
          builds.push({ assetPath, root });
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
        }

        const current = createControlUiAssetRetention(builds[3]!.root);
        await current.prepare();
        expect(current.resolveAsset(builds[0]!.assetPath)).toBeNull();
        for (const build of builds.slice(1)) {
          const retained = current.resolveAsset(build.assetPath);
          expect(retained).not.toBeNull();
          expect(await fs.readFile(retained!.filePath, "utf8")).toContain(
            path.basename(build.root).slice(-1),
          );
        }
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("defers cached-generation verification until preparation", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-deferred-"));
    const stateDir = path.join(fixture, "state");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const firstRoot = path.join(fixture, "build-a");
        const firstAsset = await writeBuild(firstRoot, "a");
        await createControlUiAssetRetention(firstRoot).prepare();

        const secondRoot = path.join(fixture, "build-b");
        await writeBuild(secondRoot, "b");
        const retention = createControlUiAssetRetention(secondRoot);

        expect(retention.resolveAsset(firstAsset)).toBeNull();
        await retention.prepare();
        expect(retention.resolveAsset(firstAsset)).not.toBeNull();
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("stops before copying when its lifecycle is cancelled", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-cancelled-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(fixture, "state") }, async () => {
        const root = path.join(fixture, "build");
        await writeBuild(root, "cancelled");
        const controller = new AbortController();
        controller.abort();

        await expect(
          createControlUiAssetRetention(root).prepare({ signal: controller.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("skips generations larger than the hard cache budget before reading assets", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-oversized-"));
    const stateDir = path.join(fixture, "state");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const root = path.join(fixture, "build");
        await fs.mkdir(root, { recursive: true });
        const manifest = createControlUiAssetManifest(
          ["a", "b"].map((label) => ({
            path: `assets/${label}.js`,
            sha256: "0".repeat(64),
            size: 50 * 1024 * 1024,
          })),
        );
        await fs.writeFile(
          path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME),
          `${JSON.stringify(manifest)}\n`,
        );

        const retention = createControlUiAssetRetention(root);
        await retention.prepare();

        expect(retention.resolveAsset("assets/a.js")).toBeNull();
        expect(await fs.readdir(path.join(stateDir, "cache", "control-ui-assets"))).toEqual([]);
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("refuses to publish bytes that do not match the build manifest", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-corrupt-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(fixture, "state") }, async () => {
        const root = path.join(fixture, "build");
        await writeBuild(root, "corrupt", true);

        await expect(createControlUiAssetRetention(root).prepare()).rejects.toThrow(
          "changed while being retained",
        );
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("does not serve cached bytes changed after publication", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-tampered-"));
    const stateDir = path.join(fixture, "state");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const originalRoot = path.join(fixture, "build-original");
        const assetPath = await writeBuild(originalRoot, "original");
        const originalRetention = createControlUiAssetRetention(originalRoot);
        await originalRetention.prepare();
        const retained = originalRetention.resolveAsset(assetPath);
        expect(retained).not.toBeNull();

        const original = await fs.readFile(retained!.filePath);
        await fs.writeFile(retained!.filePath, Buffer.alloc(original.byteLength, 0x78));

        const currentRoot = path.join(fixture, "build-current");
        await writeBuild(currentRoot, "current");
        const currentRetention = createControlUiAssetRetention(currentRoot);
        await currentRetention.prepare();
        expect(currentRetention.resolveAsset(assetPath)).toBeNull();
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });
});
