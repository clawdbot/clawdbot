import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUTURE_FIXTURE_VERSION,
  LEGACY_UPDATE_COMPAT_CHUNKS,
  markFutureUpdateFixture,
  removeLegacyUpdateCompatChunks,
} from "../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makePackageFixture() {
  const root = tempDirs.make("openclaw-first-hop-package-");
  writeJson(path.join(root, "package.json"), { name: "openclaw", version: "2026.8.1" });
  writeJson(path.join(root, "dist", "build-info.json"), {
    version: "2026.8.1",
    commit: "a".repeat(40),
    builtAt: "2026-09-02T00:00:00.000Z",
    buildId: "old-build",
  });
  const inventory = [
    "dist/build-info.json",
    ...LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`),
    "dist/index.js",
  ];
  writeJson(path.join(root, "dist", "postinstall-inventory.json"), inventory);
  for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
    fs.writeFileSync(path.join(root, "dist", name), "export function resolveNodeRunner() {}\n");
  }
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

describe("first-hop package fixtures", () => {
  it("removes only the declared legacy compatibility inputs", () => {
    const root = makePackageFixture();
    removeLegacyUpdateCompatChunks(root);

    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("export {};\n");
  });

  it("marks a distinct future package after the compatibility window closes", () => {
    const root = makePackageFixture();
    markFutureUpdateFixture(root);

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"),
    );
    expect(packageJson.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(buildInfo.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(buildInfo.buildId).toContain("future-fixture");
    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
  });
});
