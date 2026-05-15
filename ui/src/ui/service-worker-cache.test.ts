import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("Control UI service worker cache versioning", () => {
  it("registers the service worker with a build id and bounds prior build caches", () => {
    const mainSource = fs.readFileSync(path.join(here, "../main.ts"), "utf8");
    const serviceWorkerSource = fs.readFileSync(path.join(here, "../../public/sw.js"), "utf8");
    const viteConfigSource = fs.readFileSync(path.join(here, "../../vite.config.ts"), "utf8");

    expect(mainSource).toContain('swUrl.searchParams.set("v"');
    expect(mainSource).toContain('updateViaCache: "none"');
    expect(serviceWorkerSource).toContain(
      'const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__"',
    );
    expect(serviceWorkerSource).toContain("URL_CACHE_VERSION");
    expect(serviceWorkerSource).toContain("CONTROL_CACHE_LIMIT = 3");
    expect(serviceWorkerSource).toContain("slice(-priorCacheLimit)");
    expect(serviceWorkerSource).toContain("caches.delete");
    expect(viteConfigSource).toContain("source.replace(placeholder, JSON.stringify(buildId))");
    expect(serviceWorkerSource).not.toContain('const CACHE_NAME = "openclaw-control-v1"');
  });
});
