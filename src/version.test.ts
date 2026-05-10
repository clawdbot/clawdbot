import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";
import {
  VERSION,
  readVersionFromBuildInfoForModuleUrl,
  resolveCompatibilityHostVersion,
  readVersionFromPackageJsonForModuleUrl,
  resolveBinaryVersion,
  resolveRuntimeServiceVersion,
  resolveUsableRuntimeVersion,
  resolveVersionFromModuleUrl,
} from "./version.js";

const versionFixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-version-" });

beforeAll(async () => {
  await versionFixtureRoot.setup();
});

afterAll(async () => {
  await versionFixtureRoot.cleanup();
});

function moduleUrlFrom(root: string, relativePath: string): string {
  return pathToFileURL(path.join(root, relativePath)).href;
}

async function withVersionFixtureDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await run(await versionFixtureRoot.make("case"));
}

async function ensureModuleFixture(root: string, relativePath = "dist/plugin-sdk/index.js") {
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  return moduleUrlFrom(root, relativePath);
}

async function writeJsonFixture(root: string, relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

function expectVersionMetadataToBeMissing(moduleUrl: string) {
  expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBeNull();
  expect(readVersionFromBuildInfoForModuleUrl(moduleUrl)).toBeNull();
  expect(resolveVersionFromModuleUrl(moduleUrl)).toBeNull();
}

describe("version resolution", () => {
  it("resolves package version from nested dist/plugin-sdk module URL", async () => {
    await withVersionFixtureDir(async (root) => {
      await writeJsonFixture(root, "package.json", { name: "openclaw", version: "1.2.3" });
      const moduleUrl = await ensureModuleFixture(root);
      expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBe("1.2.3");
      expect(resolveVersionFromModuleUrl(moduleUrl)).toBe("1.2.3");
    });
  });

  it("ignores unrelated nearby package.json files", async () => {
    await withVersionFixtureDir(async (root) => {
      await writeJsonFixture(root, "package.json", { name: "openclaw", version: "2.3.4" });
      await writeJsonFixture(root, "dist/package.json", {
        name: "other-package",
        version: "9.9.9",
      });
      const moduleUrl = await ensureModuleFixture(root);
      expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBe("2.3.4");
    });
  });

  it("falls back to build-info when package metadata is unavailable", async () => {
    await withVersionFixtureDir(async (root) => {
      await writeJsonFixture(root, "build-info.json", { version: "4.5.6" });
      const moduleUrl = await ensureModuleFixture(root);
      expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBeNull();
      expect(readVersionFromBuildInfoForModuleUrl(moduleUrl)).toBe("4.5.6");
      expect(resolveVersionFromModuleUrl(moduleUrl)).toBe("4.5.6");
    });
  });

  it("returns null when no version metadata exists", async () => {
    await withVersionFixtureDir(async (root) => {
      const moduleUrl = await ensureModuleFixture(root);
      expectVersionMetadataToBeMissing(moduleUrl);
    });
  });

  it("ignores non-openclaw package and blank build-info versions", async () => {
    await withVersionFixtureDir(async (root) => {
      await writeJsonFixture(root, "package.json", { name: "other-package", version: "9.9.9" });
      await writeJsonFixture(root, "build-info.json", { version: "  " });
      const moduleUrl = await ensureModuleFixture(root);
      expectVersionMetadataToBeMissing(moduleUrl);
    });
  });

  it("returns null for malformed module URLs", () => {
    expect(readVersionFromPackageJsonForModuleUrl("not-a-valid-url")).toBeNull();
    expect(readVersionFromBuildInfoForModuleUrl("not-a-valid-url")).toBeNull();
    expect(resolveVersionFromModuleUrl("not-a-valid-url")).toBeNull();
  });

  it("resolves binary version with explicit precedence", async () => {
    await withVersionFixtureDir(async (root) => {
      await writeJsonFixture(root, "package.json", { name: "openclaw", version: "2.3.4" });
      const moduleUrl = await ensureModuleFixture(root);
      expect(
        resolveBinaryVersion({
          moduleUrl,
          injectedVersion: "9.9.9",
          bundledVersion: "8.8.8",
          fallback: "0.0.0",
        }),
      ).toBe("9.9.9");
      expect(
        resolveBinaryVersion({
          moduleUrl,
          bundledVersion: "8.8.8",
          fallback: "0.0.0",
        }),
      ).toBe("2.3.4");
      expect(
        resolveBinaryVersion({
          moduleUrl: "not-a-valid-url",
          bundledVersion: "8.8.8",
          fallback: "0.0.0",
        }),
      ).toBe("8.8.8");
      expect(
        resolveBinaryVersion({
          moduleUrl: "not-a-valid-url",
          bundledVersion: "   ",
          fallback: "0.0.0",
        }),
      ).toBe("0.0.0");
    });
  });

  it("prefers OPENCLAW_VERSION over service and package versions", () => {
    expect(
      resolveRuntimeServiceVersion({
        OPENCLAW_VERSION: "9.9.9",
        OPENCLAW_SERVICE_VERSION: "2.2.2",
        npm_package_version: "1.1.1",
      }),
    ).toBe("9.9.9");
  });

  function restoreEnvValue(key: string, value: string | undefined) {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  }

  it("prefers runtime VERSION over stale OPENCLAW_VERSION for compatibility checks", () => {
    const previous = process.env.OPENCLAW_VERSION;
    const previousService = process.env.OPENCLAW_SERVICE_VERSION;
    const previousPackage = process.env.npm_package_version;
    try {
      process.env.OPENCLAW_VERSION = "2026.3.25";
      process.env.OPENCLAW_SERVICE_VERSION = "2026.3.25-service";
      process.env.npm_package_version = "2026.3.25-package";
      expect(resolveCompatibilityHostVersion()).toBe(VERSION);
    } finally {
      restoreEnvValue("OPENCLAW_VERSION", previous);
      restoreEnvValue("OPENCLAW_SERVICE_VERSION", previousService);
      restoreEnvValue("npm_package_version", previousPackage);
    }
  });

  it("keeps explicit env-object overrides for compatibility checks in tests", () => {
    expect(
      resolveCompatibilityHostVersion({
        OPENCLAW_VERSION: "2026.3.99",
        OPENCLAW_SERVICE_VERSION: "2026.3.98",
        npm_package_version: "2026.3.97",
      }),
    ).toBe("2026.3.99");
  });

  it("prefers explicit compatibility host overrides over runtime and stale env versions", () => {
    expect(
      resolveCompatibilityHostVersion({
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.4.8",
        OPENCLAW_VERSION: "2026.3.99",
        OPENCLAW_SERVICE_VERSION: "2026.3.98",
        npm_package_version: "2026.3.97",
      }),
    ).toBe("2026.4.8");
  });

  it("normalizes runtime version candidate for fallback handling", () => {
    expect(resolveUsableRuntimeVersion(undefined)).toBeUndefined();
    expect(resolveUsableRuntimeVersion("")).toBeUndefined();
    expect(resolveUsableRuntimeVersion(" \t ")).toBeUndefined();
    expect(resolveUsableRuntimeVersion("0.0.0")).toBeUndefined();
    expect(resolveUsableRuntimeVersion(" 0.0.0 ")).toBeUndefined();
    expect(resolveUsableRuntimeVersion("2026.3.2")).toBe("2026.3.2");
    expect(resolveUsableRuntimeVersion(" 2026.3.2 ")).toBe("2026.3.2");
  });

  it("prefers runtime VERSION over service/package markers and ignores unusable env values", () => {
    expect(
      resolveRuntimeServiceVersion({
        OPENCLAW_VERSION: "   ",
        OPENCLAW_SERVICE_VERSION: "  2.0.0  ",
        npm_package_version: "1.0.0",
      }),
    ).toBe(VERSION);

    expect(
      resolveRuntimeServiceVersion({
        OPENCLAW_VERSION: " ",
        OPENCLAW_SERVICE_VERSION: "\t",
        npm_package_version: " 1.0.0-package ",
      }),
    ).toBe(VERSION);

    expect(
      resolveRuntimeServiceVersion(
        {
          OPENCLAW_VERSION: "",
          OPENCLAW_SERVICE_VERSION: " ",
          npm_package_version: "",
        },
        "fallback",
      ),
    ).toBe(VERSION);

    expect(
      resolveRuntimeServiceVersion({
        OPENCLAW_VERSION: "undefined",
        OPENCLAW_SERVICE_VERSION: "null",
        npm_package_version: "1.0.0-package",
      }),
    ).toBe(VERSION);
  });
});
