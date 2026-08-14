import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryResolvePathCaseInsensitive, withReadOnlyPathCaseProbe } from "./path-case.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("read-only path case probing", () => {
  it("reports an empty directory as indeterminate without creating a probe entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-case-read-only-"));
    roots.add(root);
    const before = fs.statSync(root, { bigint: true }).mtimeNs;

    const result = await withReadOnlyPathCaseProbe(() =>
      tryResolvePathCaseInsensitive(path.join(root, "missing", "path")),
    );

    expect(result.value).toBeUndefined();
    expect(result.unresolvedDirectories).toEqual([root]);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.statSync(root, { bigint: true }).mtimeNs).toBe(before);
  });

  it("uses existing entries without reporting ambiguity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-case-existing-"));
    roots.add(root);
    fs.mkdirSync(path.join(root, "Agent"));

    const result = await withReadOnlyPathCaseProbe(() =>
      tryResolvePathCaseInsensitive(path.join(root, "Agent")),
    );

    expect(typeof result.value).toBe("boolean");
    expect(result.unresolvedDirectories).toEqual([]);
    expect(fs.readdirSync(root)).toEqual(["Agent"]);
  });
});
