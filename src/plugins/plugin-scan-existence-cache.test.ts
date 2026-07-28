// Verifies the scan-scoped plugin existence cache: within a scan pass repeated
// probes hit the filesystem once, across scans the filesystem is re-read (no
// process-global staleness), and outside a scan it is a plain passthrough.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBundleManifest, detectBundleManifestFormat } from "./bundle-manifest.js";
import {
  pluginScanExistsSync,
  withPluginScanExistenceCache,
} from "./plugin-scan-existence-cache.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("pluginScanExistsSync", () => {
  it("is a plain passthrough outside a scan (no caching)", () => {
    const dir = makeTempDir("exists-passthrough-");
    const target = path.join(dir, "marker.json");
    fs.writeFileSync(target, "{}");
    const spy = vi.spyOn(fs, "existsSync");
    try {
      expect(pluginScanExistsSync(target)).toBe(true);
      expect(pluginScanExistsSync(target)).toBe(true);
      expect(pluginScanExistsSync(target)).toBe(true);
      // No active scan cache: every probe reaches the filesystem.
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("memoizes repeated probes within a single scan pass", () => {
    const dir = makeTempDir("exists-memoize-");
    const target = path.join(dir, "marker.json");
    fs.writeFileSync(target, "{}");
    const spy = vi.spyOn(fs, "existsSync");
    try {
      const result = withPluginScanExistenceCache(() => {
        let hit = false;
        for (let i = 0; i < 5; i += 1) {
          if (pluginScanExistsSync(target)) {
            hit = true;
          }
        }
        return hit;
      });
      expect(result).toBe(true);
      // Five probes of the same path, one filesystem call inside the scan.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not conflate different paths inside a scan", () => {
    const dir = makeTempDir("exists-distinct-");
    const present = path.join(dir, "present.json");
    const absent = path.join(dir, "absent.json");
    fs.writeFileSync(present, "{}");
    const spy = vi.spyOn(fs, "existsSync");
    try {
      withPluginScanExistenceCache(() => {
        expect(pluginScanExistsSync(present)).toBe(true);
        expect(pluginScanExistsSync(absent)).toBe(false);
        // Re-probe both: served from cache, no new filesystem calls.
        expect(pluginScanExistsSync(present)).toBe(true);
        expect(pluginScanExistsSync(absent)).toBe(false);
      });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-reads the filesystem across separate scans (no process-global staleness)", () => {
    const dir = makeTempDir("exists-freshness-");
    const target = path.join(dir, "marker.json");
    // First scan sees the path absent.
    withPluginScanExistenceCache(() => {
      expect(pluginScanExistsSync(target)).toBe(false);
    });
    // Marker appears between scans (e.g. an install/repair pass).
    fs.writeFileSync(target, "{}");
    // A later scan must observe the new state, not a stale cached false.
    withPluginScanExistenceCache(() => {
      expect(pluginScanExistsSync(target)).toBe(true);
    });
  });
});

describe("bundle manifest scan uses the existence cache", () => {
  function buildClaudeBundlePlugin(root: string): void {
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "demo-bundle" }),
    );
    // Capability marker dirs/files that both detectBundleManifestFormat and
    // loadBundleManifest probe for a claude-format bundle.
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    fs.mkdirSync(path.join(root, "commands"), { recursive: true });
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".mcp.json"), "{}");
    fs.writeFileSync(path.join(root, ".lsp.json"), "{}");
    fs.writeFileSync(path.join(root, "settings.json"), "{}");
  }

  it("reduces fs.existsSync calls when detect + load run under one scan cache", () => {
    const root = makeTempDir("claude-bundle-");
    buildClaudeBundlePlugin(root);

    // Run a detect + load pair and count fs.existsSync calls under a spy.
    const detectAndLoad = (): void => {
      const format = detectBundleManifestFormat(root);
      if (format) {
        loadBundleManifest({ rootDir: root, bundleFormat: format });
      }
    };
    const countExistsSyncCalls = (run: () => void): number => {
      const spy = vi.spyOn(fs, "existsSync");
      try {
        run();
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    // Baseline: no scan cache → detect and load re-probe the same marker paths.
    const uncachedCalls = countExistsSyncCalls(detectAndLoad);
    // Same workload, but the detect + load pair shares one scan cache.
    const cachedCalls = countExistsSyncCalls(() => withPluginScanExistenceCache(detectAndLoad));

    // Both paths must still produce a valid claude bundle manifest.
    const manifest = withPluginScanExistenceCache(() => {
      const format = detectBundleManifestFormat(root);
      return format ? loadBundleManifest({ rootDir: root, bundleFormat: format }) : null;
    });
    expect(manifest?.ok).toBe(true);

    // The cache must eliminate the redundant probes; assert a real reduction
    // rather than an exact count so the test is robust to marker-set changes.
    expect(cachedCalls).toBeLessThan(uncachedCalls);
    expect(cachedCalls).toBeGreaterThan(0);
  });
});
