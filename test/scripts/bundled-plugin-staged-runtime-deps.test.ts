import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectBuiltBundledPluginStagedRuntimeDependencyErrors } from "../../scripts/lib/bundled-plugin-root-runtime-mirrors.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeJson(root: string, relativePath: string, value: unknown) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("collectBuiltBundledPluginStagedRuntimeDependencyErrors", () => {
  it("flags built staged plugins whose dist node_modules are missing runtime deps", () => {
    const repoRoot = createTempDir("openclaw-runtime-contracts-");

    writeJson(repoRoot, "dist/extensions/diffs/package.json", {
      name: "@openclaw/diffs",
      dependencies: {
        "@pierre/diffs": "^0.1.0",
      },
      openclaw: {
        bundle: {
          stageRuntimeDependencies: true,
        },
      },
    });

    expect(
      collectBuiltBundledPluginStagedRuntimeDependencyErrors({
        bundledPluginsDir: path.join(repoRoot, "dist/extensions"),
      }),
    ).toEqual([
      "built bundled plugin 'diffs' is missing staged runtime dependency '@pierre/diffs: ^0.1.0' under dist/extensions/diffs/node_modules.",
    ]);
  });

  it("accepts built staged plugins when their staged runtime deps are present", () => {
    const repoRoot = createTempDir("openclaw-runtime-contracts-");

    writeJson(repoRoot, "dist/extensions/diffs/package.json", {
      name: "@openclaw/diffs",
      dependencies: {
        "@pierre/diffs": "^0.1.0",
      },
      openclaw: {
        bundle: {
          stageRuntimeDependencies: true,
        },
      },
    });
    writeJson(repoRoot, "dist/extensions/diffs/node_modules/@pierre/diffs/package.json", {
      name: "@pierre/diffs",
      version: "0.1.0",
    });

    expect(
      collectBuiltBundledPluginStagedRuntimeDependencyErrors({
        bundledPluginsDir: path.join(repoRoot, "dist/extensions"),
      }),
    ).toEqual([]);
  });
});
