import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSurfaceDispositions } from "../../scripts/localization-surfaces.js";

const SOURCE_PATH = "product/i18n/catalogs/en.json";
const TARGET_PATH = "product/i18n/catalogs/generated/zh-CN.json";
let root: string;

async function writeJson(relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function registry(surfaces: unknown[]) {
  return {
    schemaVersion: 1,
    adapters: [
      {
        id: "wizard-catalog-sources",
        owner: "wizard",
        roots: ["product"],
        extensions: [".json"],
      },
    ],
    surfaces,
  };
}

function catalogRegistry(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    areas: [
      {
        id: "wizard-core",
        owner: "wizard",
        namespace: "wizard",
        source: SOURCE_PATH,
        targets: [{ locale: "zh-CN", path: TARGET_PATH }],
        protectedLiterals: [],
        ...overrides,
      },
    ],
  };
}

const adoptedSurface = {
  id: "wizard-core",
  owner: "wizard",
  namespace: "wizard",
  source: SOURCE_PATH,
  disposition: "adopted",
  catalogArea: "wizard-core",
};

async function check() {
  return await checkSurfaceDispositions({
    root,
    registryPath: "registry.json",
    catalogRegistryPath: "catalogs.json",
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openclaw-localization-surfaces-"));
  await writeJson(SOURCE_PATH, { schemaVersion: 1, area: "wizard-core", messages: {} });
  await writeJson(TARGET_PATH, { messages: {} });
  await writeJson("registry.json", registry([adoptedSurface]));
  await writeJson("catalogs.json", catalogRegistry());
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("localization surface dispositions", () => {
  it("accepts a bijective adopted source and derives generated exclusions", async () => {
    await expect(check()).resolves.toBe(1);
  });

  it("blocks a newly enumerated source before it has a disposition", async () => {
    await writeJson("product/new-surface.json", { messages: {} });

    await expect(check()).rejects.toThrow(
      "new product-string surface product/new-surface.json from adapter wizard-catalog-sources has no localization disposition",
    );
  });

  it("accepts a deferred source with a durable blocker and review owner", async () => {
    await writeJson("product/new-surface.json", { messages: {} });
    await writeJson(
      "registry.json",
      registry([
        adoptedSurface,
        {
          id: "wizard-new-surface",
          owner: "wizard",
          source: "product/new-surface.json",
          disposition: "deferred",
          blockerIssue: 113105,
          reviewOwner: "@wizard-owner",
        },
      ]),
    );

    await expect(check()).resolves.toBe(2);
  });

  it("rejects a deferred source without durable evidence", async () => {
    await writeJson("product/new-surface.json", { messages: {} });
    await writeJson(
      "registry.json",
      registry([
        adoptedSurface,
        {
          id: "wizard-new-surface",
          owner: "wizard",
          source: "product/new-surface.json",
          disposition: "deferred",
          blockerIssue: 0,
          reviewOwner: "wizard owner",
        },
      ]),
    );

    await expect(check()).rejects.toThrow("must be a positive issue number");
  });

  it("accepts a source resolved through a closed conforming pipeline", async () => {
    const value = registry([
      adoptedSurface,
      {
        id: "control-ui-core",
        owner: "control-ui",
        source: "ui/en.json",
        disposition: "conforming-pipeline",
        pipeline: "control-ui",
      },
    ]);
    value.adapters.push({
      id: "control-ui-sources",
      owner: "control-ui",
      roots: ["ui"],
      extensions: [".json"],
    });
    await writeJson("ui/en.json", { messages: {} });
    await writeJson("registry.json", value);

    await expect(check()).resolves.toBe(2);
  });

  it("rejects an unknown or owner-mismatched conforming pipeline", async () => {
    await writeJson(
      "registry.json",
      registry([
        {
          id: "wizard-core",
          owner: "wizard",
          source: SOURCE_PATH,
          disposition: "conforming-pipeline",
          pipeline: "wizard-owned catalog refresh",
        },
      ]),
    );

    await expect(check()).rejects.toThrow("unsupported conforming pipeline");
  });

  it("rejects incompatible extra disposition fields", async () => {
    await writeJson(
      "registry.json",
      registry([{ ...adoptedSurface, rationale: "unreviewed escape hatch" }]),
    );

    await expect(check()).rejects.toThrow("must contain exactly");
  });

  it("rejects a disposition assigned to a different semantic owner", async () => {
    await writeJson("registry.json", registry([{ ...adoptedSurface, owner: "other-owner" }]));

    await expect(check()).rejects.toThrow(
      "surface wizard-core owner other-owner does not match adapter wizard-catalog-sources owner wizard",
    );
  });

  it("rejects an adopted source that does not match its catalog area", async () => {
    await rm(path.join(root, TARGET_PATH));
    await writeJson("other/i18n/catalogs/generated/zh-CN.json", { messages: {} });
    await writeJson(
      "catalogs.json",
      catalogRegistry({
        source: "other/i18n/catalogs/en.json",
        targets: [{ locale: "zh-CN", path: "other/i18n/catalogs/generated/zh-CN.json" }],
      }),
    );

    await expect(check()).rejects.toThrow(
      "does not match catalog area wizard-core source other/i18n/catalogs/en.json",
    );
  });

  it("rejects a catalog source relabeled as a conforming pipeline", async () => {
    await writeJson(
      "registry.json",
      registry([
        {
          id: "wizard-core",
          owner: "wizard",
          source: SOURCE_PATH,
          disposition: "english-only",
          reason: "developer-only",
        },
      ]),
    );

    await expect(check()).rejects.toThrow(
      "catalog area wizard-core has no adopted surface disposition",
    );
  });

  it("rejects catalog and surface owner disagreement", async () => {
    await writeJson("catalogs.json", catalogRegistry({ owner: "other-owner" }));

    await expect(check()).rejects.toThrow(
      "surface wizard-core owner wizard does not match catalog area wizard-core owner other-owner",
    );
  });

  it("rejects catalog and surface namespace disagreement", async () => {
    await writeJson("catalogs.json", catalogRegistry({ namespace: "other" }));

    await expect(check()).rejects.toThrow(
      "surface wizard-core namespace wizard does not match catalog area wizard-core namespace other",
    );
  });

  it("rejects a catalog area without exactly one adopted surface", async () => {
    const value = catalogRegistry();
    value.areas.push({
      id: "orphan",
      owner: "wizard",
      namespace: "orphan",
      source: "orphan/i18n/catalogs/en.json",
      targets: [{ locale: "zh-CN", path: "orphan/i18n/catalogs/generated/zh-CN.json" }],
      protectedLiterals: [],
    });
    await writeJson("orphan/i18n/catalogs/en.json", { messages: {} });
    await writeJson("orphan/i18n/catalogs/generated/zh-CN.json", { messages: {} });
    await writeJson("catalogs.json", value);

    await expect(check()).rejects.toThrow("catalog area orphan has no adopted surface disposition");
  });

  it("rejects stale dispositions outside the owner adapter inventory", async () => {
    await writeJson(
      "registry.json",
      registry([
        adoptedSurface,
        {
          id: "stale-surface",
          owner: "wizard",
          source: "product/missing.json",
          disposition: "english-only",
          reason: "developer-only",
        },
      ]),
    );

    await expect(check()).rejects.toThrow(
      "surface stale-surface declares undiscovered source product/missing.json",
    );
  });

  it.each(["C:/outside/product/en.json", "C:relative/product/en.json", "D:relative.json"])(
    "rejects Windows drive path %s on every host platform",
    async (source) => {
      await writeJson("registry.json", registry([{ ...adoptedSurface, source }]));
      await expect(check()).rejects.toThrow("normalized repository-relative path");
    },
  );

  it("rejects arbitrary adapter exclusions", async () => {
    const value = registry([adoptedSurface]);
    Object.assign(value.adapters[0]!, { excludedRoots: ["product/hidden"] });
    await writeJson("registry.json", value);

    await expect(check()).rejects.toThrow("adapters[0] must contain exactly");
  });

  it("rejects a stale generated target instead of treating it as excluded", async () => {
    await rm(path.join(root, TARGET_PATH));

    await expect(check()).rejects.toThrow(`generated catalog target is missing: ${TARGET_PATH}`);
  });

  it("rejects a generated target that is a directory", async () => {
    await rm(path.join(root, TARGET_PATH));
    await mkdir(path.join(root, TARGET_PATH));

    await expect(check()).rejects.toThrow(`generated catalog target is not a file: ${TARGET_PATH}`);
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked generated target", async () => {
    const outside = path.join(root, "outside.json");
    await writeJson("outside.json", { messages: {} });
    await rm(path.join(root, TARGET_PATH));
    await symlink(outside, path.join(root, TARGET_PATH));

    await expect(check()).rejects.toThrow(
      `adapter wizard-catalog-sources encountered symbolic link ${TARGET_PATH}`,
    );
  });

  it("rejects a symbolic link used as a declared owner root", async () => {
    await rm(path.join(root, "product"), { recursive: true, force: true });
    await writeJson("linked-product/i18n/catalogs/en.json", { messages: {} });
    await symlink(
      path.join(root, "linked-product"),
      path.join(root, "product"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(check()).rejects.toThrow(
      "adapter wizard-catalog-sources declared root traverses symbolic link product",
    );
  });
});
