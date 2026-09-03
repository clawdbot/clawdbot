// @vitest-environment node
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build, createLogger, type InlineConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiAssetManifest } from "../../../src/gateway/control-ui-asset-manifest.ts";
import controlUiViteConfig from "../../vite.config.ts";

describe("Control UI Vite build", () => {
  let root: string;
  let outDir: string;
  let config: InlineConfig;
  const info = vi.fn<(message: string) => void>();

  function captureLogs(level: "info" | "silent") {
    info.mockReset();
    config.logLevel = level;
    config.customLogger = createLogger(level, {
      allowClearScreen: false,
      console: { ...console, log: info, error: vi.fn() },
    });
  }

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
    captureLogs("silent");
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
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves an unresolved import diagnostic with a fresh output directory", async () => {
    captureLogs("info");
    await fs.writeFile(path.join(root, "main.js"), 'import "./missing-module.js";');

    const result = build(config);

    await expect(result).rejects.toThrow(/Could not resolve.*missing-module\.js/u);
    await expect(result).rejects.not.toThrow(/ENOENT|asset-manifest/u);
    await expect(fs.stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(info.mock.calls.flat().join("\n")).not.toMatch(/precompression complete|built in/u);
  });

  it("reports completed compression work before build completion at a bounded cadence", async () => {
    captureLogs("info");
    let clockMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clockMs);
    const writeFileSync = fsSync.writeFileSync;
    vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, ...args) => {
      writeFileSync(file, ...args);
      if (String(file).endsWith(".br") || String(file).endsWith(".gz")) {
        clockMs += 2_500;
      }
    });
    const activity: Array<{ message: string; elapsed: number; assets: number; sidecars: number }> =
      [];
    info.mockImplementation((message: string) => {
      if (!message.includes("Control UI precompression")) {
        return;
      }
      const emitted = fsSync.readdirSync(path.join(outDir, "assets"));
      activity.push({
        message,
        elapsed: clockMs,
        assets: emitted.filter(
          (name) => name.endsWith(".br") && emitted.includes(name.replace(/\.br$/u, ".gz")),
        ).length,
        sidecars: emitted.filter((name) => /\.(br|gz)$/u.test(name)).length,
      });
      // The logger observes real disk writes while build() is still finalizing.
      expect(fsSync.existsSync(path.join(outDir, "asset-manifest.json"))).toBe(false);
    });
    config.plugins = [
      ...(config.plugins ?? []),
      {
        name: "compression-progress-fixture",
        generateBundle() {
          for (let index = 0; index < 4; index++) {
            this.emitFile({
              type: "asset",
              fileName: `assets/extra-${index}.txt`,
              source: "fixture",
            });
          }
        },
      },
    ];

    await build(config);

    const emitted = await fs.readdir(path.join(outDir, "assets"));
    const completed = emitted.filter((name) => name.endsWith(".gz")).length;
    expect(completed).toBeGreaterThan(4);
    expect(
      activity.map(({ elapsed, assets, sidecars }) => ({ elapsed, assets, sidecars })),
    ).toEqual([
      ...Array.from({ length: Math.floor(completed / 2) + 1 }, (_, index) => ({
        elapsed: index * 10_000,
        assets: index * 2,
        sidecars: index * 4,
      })),
      { elapsed: completed * 5_000, assets: completed, sidecars: completed * 2 },
    ]);
    expect(activity[0]?.message).toMatch(/starting/u);
    for (const entry of activity.slice(1)) {
      expect(entry.message).toContain(`${entry.assets} assets (${entry.sidecars} sidecars)`);
    }
    expect(activity.at(-1)?.message).toContain("precompression complete");
    await expect(fs.stat(path.join(outDir, "asset-manifest.json"))).resolves.toBeDefined();
  });

  it("inventories final emitted bytes and compressed variants, excluding source maps", async () => {
    config.publicDir = fileURLToPath(new URL("../../public", import.meta.url));
    await fs.writeFile(
      path.join(root, "index.html"),
      '<html><body><button>Load</button><script type="module" src="./main.js"></script></body></html>',
    );
    await build(config);
    expect(info).not.toHaveBeenCalled();

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

    const html = await fs.readFile(path.join(outDir, "index.html"), "utf8");
    const cacheId = /data-openclaw-control-ui-build-id="([^"]+)"/u.exec(html)?.[1];
    expect(cacheId?.startsWith(`${buildInfo.buildId}-`)).toBe(true);
    expect(cacheId?.slice(buildInfo.buildId.length + 1)).toMatch(/^[a-f0-9]{64}$/u);
    const fonts = await fs.readdir(path.join(outDir, "fonts"));
    for (const fontCss of fonts.filter((name) => name.endsWith(".css"))) {
      const source = await fs.readFile(path.join(outDir, "fonts", fontCss), "utf8");
      const references = [...source.matchAll(/url\("([^"]+)"\)/gu)];
      expect(references.length).toBeGreaterThan(0);
      for (const [, reference] of references) {
        const fontUrl = new URL(
          reference!,
          `https://control.example/ui/fonts/${fontCss}?v=${cacheId}`,
        );
        expect(fontUrl.searchParams.get("v")).toBe(cacheId);
        expect(fontUrl.pathname).toMatch(/^\/ui\/fonts\/[^/]+\.woff2$/u);
        await expect(
          fs.stat(path.join(outDir, fontUrl.pathname.slice("/ui/".length))),
        ).resolves.toBeDefined();
      }
    }
    const webManifest: { start_url: string; icons: Array<{ src: string }> } = JSON.parse(
      await fs.readFile(path.join(outDir, "manifest.webmanifest"), "utf8"),
    );
    expect(webManifest.start_url).toBe("./");
    for (const icon of webManifest.icons) {
      const iconUrl = new URL(icon.src, "https://control.example/ui/manifest.webmanifest");
      expect(iconUrl.searchParams.get("v")).toBe(cacheId);
      await expect(
        fs.stat(path.join(outDir, iconUrl.pathname.slice("/ui/".length))),
      ).resolves.toBeDefined();
    }
  });

  it("changes the public asset version after a same-commit rebuild without changing worker identity", async () => {
    const publicDir = path.join(root, "public");
    await fs.mkdir(publicDir);
    config.publicDir = publicDir;
    await fs.writeFile(
      path.join(root, "index.html"),
      '<html><script type="module" src="./main.js"></script></html>',
    );
    const buildInfo = JSON.parse(config.define?.["globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO"]);
    const cacheIds: string[] = [];
    for (const title of ["First", "Second"]) {
      await fs.writeFile(path.join(publicDir, "favicon.svg"), `<svg><title>${title}</title></svg>`);
      await build(config);
      const html = await fs.readFile(path.join(outDir, "index.html"), "utf8");
      const cacheId = /data-openclaw-control-ui-build-id="([^"]+)"/u.exec(html)?.[1];
      expect(cacheId).toBeDefined();
      cacheIds.push(cacheId!);
      const worker = await fs.readFile(path.join(outDir, "sw.js"), "utf8");
      expect(/const EMBEDDED_CACHE_VERSION = "([^"]+)"/u.exec(worker)?.[1]).toBe(buildInfo.buildId);
    }
    expect(cacheIds[0]).not.toBe(cacheIds[1]);
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
    captureLogs("info");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, "blocked"), "output obstruction");
    config.build = { ...config.build, emptyOutDir: false, assetsDir: "blocked" };

    const result = build(config);

    await expect(result).rejects.toThrow(/blocked/u);
    await expect(result).rejects.not.toThrow(/scandir|asset-manifest/u);
    expect(info.mock.calls.flat().join("\n")).not.toMatch(/precompression complete|built in/u);
    expect(await fs.readFile(path.join(outDir, "blocked"), "utf8")).toBe("output obstruction");
    for (const file of ["asset-manifest.json", "sw.js"]) {
      await expect(fs.stat(path.join(outDir, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not count an asset or report completion when its second sidecar write fails", async () => {
    captureLogs("info");
    const writeFileSync = fsSync.writeFileSync;
    vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, ...args) => {
      if (String(file).endsWith(".gz")) {
        throw new Error("synthetic gzip write failure");
      }
      writeFileSync(file, ...args);
    });

    await expect(build(config)).rejects.toThrow("synthetic gzip write failure");

    const output = info.mock.calls.flat().join("\n");
    expect(output).toContain("Control UI precompression: starting");
    expect(output).not.toMatch(/\d+ assets|precompression complete|built in/u);
    const emitted = await fs.readdir(path.join(outDir, "assets"));
    expect(emitted.filter((name) => name.endsWith(".br"))).toHaveLength(1);
    expect(emitted.filter((name) => name.endsWith(".gz"))).toHaveLength(0);
    await expect(fs.stat(path.join(outDir, "asset-manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
