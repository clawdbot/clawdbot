import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "./default-template.js";
import { loadUsageBarTemplate } from "./template.js";
import { clearUsageBarTemplateCacheForTest } from "./template.test-support.js";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: warnSpy }),
}));

const tplA = { segments: [{ text: "A" }] };
const tplB = { output: { default: [{ text: "B" }] } };

const cleanups: Array<() => void> = [];

afterEach(() => {
  clearUsageBarTemplateCacheForTest();
  warnSpy.mockClear();
  for (const fn of cleanups.splice(0)) {
    fn();
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "usage-template-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function tmpFile(name: string, contents: string): string {
  const d = tmpDir();
  const path = join(d, name);
  writeFileSync(path, contents);
  return path;
}

describe("loadUsageBarTemplate", () => {
  it("returns the built-in template when unset", () => {
    expect(loadUsageBarTemplate(undefined)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
  });

  it("returns an inline template object when usable", () => {
    expect(loadUsageBarTemplate(tplA)).toBe(tplA);
  });

  it("falls back to the built-in template for an unusable inline object", () => {
    expect(loadUsageBarTemplate({ nope: true })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toMatchObject([
      "configured usage template could not be used; using built-in footer",
      { source: "inline", reason: "unsupported-shape" },
    ]);
  });

  it("falls back quietly for an empty inline template", () => {
    expect(loadUsageBarTemplate({ output: {} })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(loadUsageBarTemplate({ output: { default: [] } })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("loads and parses a template file", () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);
  });

  it("falls back to the built-in template for invalid JSON", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toMatchObject([
      "configured usage template could not be used; using built-in footer",
      { source: "file", reason: "invalid-json", path },
    ]);
  });

  it("falls back to the built-in template for an empty template file", () => {
    const path = tmpFile("empty.json", JSON.stringify({ output: { default: [] } }));
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reloads a path after an initial miss", () => {
    const dir = tmpDir();
    const missing = join(dir, "missing.json");
    expect(loadUsageBarTemplate(missing)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).not.toHaveBeenCalled();
    writeFileSync(missing, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(missing)).toMatchObject(tplB);
  });

  it("reloads a path after invalid JSON is fixed", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    writeFileSync(path, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });

  it("serves the cached template without re-reading the file", () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);

    writeFileSync(path, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);

    clearUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });

  it("bounds invalid-template warnings by least-recently-used path", () => {
    const dir = tmpDir();
    const paths = Array.from({ length: 257 }, (_, index) => {
      const path = join(dir, `bad-${index}.json`);
      writeFileSync(path, "{ not json");
      return path;
    });

    for (const path of paths.slice(0, 256)) {
      expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    }
    expect(warnSpy).toHaveBeenCalledTimes(256);

    // Refresh the oldest warning before overflow so the next key becomes the LRU victim.
    expect(loadUsageBarTemplate(paths[0])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(256);

    expect(loadUsageBarTemplate(paths[256])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(257);
    expect(loadUsageBarTemplate(paths[0])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(257);

    expect(loadUsageBarTemplate(paths[1])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(258);
    expect(warnSpy).toHaveBeenLastCalledWith(
      "configured usage template could not be used; using built-in footer",
      { source: "file", reason: "invalid-json", path: paths[1] },
    );
  });

  describe("cache eviction", () => {
    it("evicts the oldest entry and closes its watcher when inserting a new key over the limit", () => {
      const dir = tmpDir();
      const paths: string[] = [];
      // Create 65 template files — one more than MAX_CACHED_TEMPLATE_FILES (64).
      for (let i = 0; i < 65; i++) {
        const path = join(dir, `tpl-${i}.json`);
        writeFileSync(path, JSON.stringify({ segments: [{ text: `v1-${i}` }] }));
        paths.push(path);
      }

      // Load the first 64 files to fill the cache.
      for (let i = 0; i < 64; i++) {
        expect(loadUsageBarTemplate(paths[i])).toMatchObject({
          segments: [{ text: `v1-${i}` }],
        });
      }

      // Insert the 65th file — should evict the oldest (paths[0]) and close
      // its watcher before allocating a watcher for paths[64].
      expect(loadUsageBarTemplate(paths[64])).toMatchObject({
        segments: [{ text: "v1-64" }],
      });

      // paths[1] was NOT evicted: it still returns the cached value.
      // Must check BEFORE re-accessing paths[0], because re-inserting the
      // evicted path into a full cache would evict the next-oldest entry.
      expect(loadUsageBarTemplate(paths[1])).toMatchObject({
        segments: [{ text: "v1-1" }],
      });

      // Modify the evicted file on disk then re-access it. Because the entry
      // was evicted and its watcher closed, the next access must re-read from
      // disk — not return stale in-memory data. This proves both eviction and
      // watcher closure. Re-accessing paths[0] may evict another entry, but
      // the non-evicted check above has already completed.
      writeFileSync(
        expectDefined(paths[0], "paths[0] test invariant"),
        JSON.stringify({ segments: [{ text: "v2-0" }] }),
      );
      expect(loadUsageBarTemplate(paths[0])).toMatchObject({
        segments: [{ text: "v2-0" }],
      });
    });

    it("does not evict when retrying the same key after a prior miss", () => {
      const dir = tmpDir();
      // Fill the cache with 63 valid files plus 1 invalid file = 64 entries.
      const validPaths: string[] = [];
      for (let i = 0; i < 63; i++) {
        const path = join(dir, `good-${i}.json`);
        writeFileSync(path, JSON.stringify({ segments: [{ text: `v1-${i}` }] }));
        validPaths.push(path);
      }
      const invalidPath = join(dir, "bad.json");
      writeFileSync(invalidPath, "{ not json");

      // Load 63 valid + 1 invalid = 64 entries in cache (cache full).
      for (const p of validPaths) {
        expect(loadUsageBarTemplate(p)).toMatchObject({
          segments: [{ text: expect.any(String) }],
        });
      }
      expect(loadUsageBarTemplate(invalidPath)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);

      // Fix the invalid file and retry. This is the SAME key, so it must NOT
      // evict the oldest valid entry (validPaths[0]).
      writeFileSync(invalidPath, JSON.stringify(tplB));
      expect(loadUsageBarTemplate(invalidPath)).toMatchObject(tplB);

      // validPaths[0] should still be cached — not evicted by the retry.
      writeFileSync(
        expectDefined(validPaths[0], "validPaths[0] test invariant"),
        JSON.stringify({ segments: [{ text: "changed" }] }),
      );
      expect(loadUsageBarTemplate(validPaths[0])).toMatchObject({
        segments: [{ text: `v1-0` }],
      });
    });
  });
});
