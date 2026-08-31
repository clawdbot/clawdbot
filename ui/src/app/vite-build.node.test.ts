// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build, type InlineConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlUiAssetManifest } from "../../../src/gateway/control-ui-asset-manifest.ts";
import controlUiViteConfig from "../../vite.config.ts";

describe("Control UI Vite build", () => {
  let root: string;
  let outDir: string;
  let config: InlineConfig;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "control-ui-vite-build-")));
    outDir = path.join(root, "dist");
    config = {
      ...controlUiViteConfig({ outDir }),
      configFile: false,
      root,
      publicDir: false,
      logLevel: "silent",
    };
    await fs.writeFile(
      path.join(root, "index.html"),
      '<button>Load</button><script type="module" src="./main.js"></script>',
    );
    await fs.writeFile(
      path.join(root, "main.js"),
      `document.querySelector("button").addEventListener("click", async () => {
        const { message } = await import("./lazy.js");
        document.body.dataset.message = message;
      });`,
    );
    await fs.writeFile(
      path.join(root, "lazy.js"),
      'import "./lazy.css"; export const message = "Lazy content loaded";',
    );
    await fs.writeFile(path.join(root, "lazy.css"), "body { color: green; }");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves an unresolved import diagnostic with a fresh output directory", async () => {
    await fs.writeFile(path.join(root, "main.js"), 'import "./missing-module.js";');

    const result = build(config);

    await expect(result).rejects.toThrow(/Could not resolve.*missing-module\.js/u);
    await expect(result).rejects.not.toThrow(/ENOENT|asset-manifest/u);
    await expect(fs.stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inventories final emitted bytes and compressed variants, excluding source maps", async () => {
    await build(config);

    const manifest: ControlUiAssetManifest = JSON.parse(
      await fs.readFile(path.join(outDir, "asset-manifest.json"), "utf8"),
    );
    const emitted = (await fs.readdir(path.join(outDir, "assets"))).toSorted();
    expect(emitted.some((name) => name.endsWith(".map"))).toBe(true);
    expect(manifest.assets.map((entry) => entry.path).toSorted()).toEqual(
      emitted.filter((name) => !name.endsWith(".map")).map((name) => `assets/${name}`),
    );
    for (const entry of manifest.assets) {
      const source = await fs.readFile(path.join(outDir, entry.path));
      expect(entry.size).toBe(source.byteLength);
      expect(entry.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    }

    const scripts = emitted.filter((name) => name.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(1);
    expect(emitted.some((name) => name.endsWith(".css"))).toBe(true);
    for (const name of emitted.filter((fileName) => /\.(js|css)$/u.test(fileName))) {
      const source = await fs.readFile(path.join(outDir, "assets", name));
      const brotli = await fs.readFile(path.join(outDir, "assets", `${name}.br`));
      const gzip = await fs.readFile(path.join(outDir, "assets", `${name}.gz`));
      expect(brotliDecompressSync(brotli)).toEqual(source);
      expect(gunzipSync(gzip)).toEqual(source);
    }
    const serviceWorker = await fs.readFile(path.join(outDir, "sw.js"), "utf8");
    const embeddedBuildId = /const EMBEDDED_CACHE_VERSION = "([^"]+)"/u.exec(serviceWorker)?.[1];
    const buildInfo = JSON.parse(config.define?.["globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO"]);
    expect(embeddedBuildId).toBe(buildInfo.buildId);
  });

  it("fails when a completed build emits outside the required assets directory", async () => {
    config.build = { ...config.build, assetsDir: "bundles" };

    await expect(build(config)).rejects.toThrow(/ENOENT.*assets/u);
    expect(await fs.readFile(path.join(outDir, "index.html"), "utf8")).toContain("bundles/");
    expect((await fs.readdir(path.join(outDir, "bundles"))).length).toBeGreaterThan(0);
    await expect(fs.stat(path.join(outDir, "asset-manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves an output write failure without finalizing the build", async () => {
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, "blocked"), "output obstruction");
    config.build = { ...config.build, emptyOutDir: false, assetsDir: "blocked" };

    const result = build(config);

    await expect(result).rejects.toThrow(/blocked/u);
    await expect(result).rejects.not.toThrow(/scandir|asset-manifest/u);
    expect(await fs.readFile(path.join(outDir, "blocked"), "utf8")).toBe("output obstruction");
    for (const file of ["asset-manifest.json", "sw.js"]) {
      await expect(fs.stat(path.join(outDir, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
