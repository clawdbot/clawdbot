// Extension loader tests cover SDK import resolution for jiti-loaded TypeScript
// extensions.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensionsCached } from "./loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearExtensionCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadExtensionsCached", () => {
  let result: Awaited<ReturnType<typeof loadExtensionsCached>>;

  beforeAll(async () => {
    clearExtensionCache();
    // Extensions import public SDK helpers through package subpaths; the loader
    // must route those aliases without package-manager involvement.
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-sdk-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export default async function(api) {
  if (normalizeLowercaseStringOrEmpty("  MIXED  ") !== "mixed") {
    throw new Error("generic sdk subpath unavailable");
  }
  api.registerCommand("sdk-subpath-probe", {
    description: "probe",
    handler() {},
  });
}
`,
    );

    result = await loadExtensionsCached([extensionPath], dir);
  });

  it("resolves a public plugin SDK subpath in jiti-loaded extensions", () => {
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("sdk-subpath-probe")).toBe(true);
  });
});
