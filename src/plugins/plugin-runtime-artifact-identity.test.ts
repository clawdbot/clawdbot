import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintPluginRuntimeArtifact } from "./plugin-runtime-artifact-identity.js";

const tempDirs: string[] = [];

function createPluginFixture(): { rootDir: string; source: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-artifact-"));
  tempDirs.push(rootDir);
  const source = path.join(rootDir, "dist", "index.js");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'export { run } from "./runtime.js";\n', "utf8");
  fs.writeFileSync(path.join(rootDir, "dist", "runtime.js"), "export const run = () => 1;\n");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"fixture"}\n');
  return { rootDir, source };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("fingerprintPluginRuntimeArtifact", () => {
  it("is stable for unchanged files and changes with plugin-owned imported code", () => {
    const fixture = createPluginFixture();
    const record = { pluginId: "fixture", origin: "global" as const, ...fixture };
    const first = fingerprintPluginRuntimeArtifact(record);

    expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);

    fs.writeFileSync(
      path.join(fixture.rootDir, "dist", "runtime.js"),
      "export const run = () => 2;\n",
    );
    expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(first);
  });

  it("keeps dependency stores outside the plugin-owned artifact identity", () => {
    const fixture = createPluginFixture();
    const dependency = path.join(fixture.rootDir, "node_modules", "dependency", "index.js");
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, "export const value = 1;\n");
    const record = { pluginId: "fixture", origin: "global" as const, ...fixture };
    const first = fingerprintPluginRuntimeArtifact(record);

    fs.writeFileSync(dependency, "export const value = 2;\n");
    expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);
  });

  it("hashes canonical dist content when the registry points at dist-runtime", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-artifact-"));
    tempDirs.push(packageRoot);
    const stagingRoot = path.join(packageRoot, "dist-runtime", "extensions", "fixture");
    const canonicalRoot = path.join(packageRoot, "dist", "extensions", "fixture");
    const stagingSource = path.join(stagingRoot, "index.js");
    const canonicalSource = path.join(canonicalRoot, "index.js");
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.mkdirSync(canonicalRoot, { recursive: true });
    fs.writeFileSync(stagingSource, "export const revision = 'staging-1';\n");
    fs.writeFileSync(canonicalSource, "export const revision = 'canonical-1';\n");
    const record = {
      pluginId: "fixture",
      origin: "bundled" as const,
      rootDir: stagingRoot,
      source: stagingSource,
    };
    const first = fingerprintPluginRuntimeArtifact(record);

    fs.writeFileSync(stagingSource, "export const revision = 'staging-2';\n");
    expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);

    fs.writeFileSync(canonicalSource, "export const revision = 'canonical-2';\n");
    expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(first);
  });
});
