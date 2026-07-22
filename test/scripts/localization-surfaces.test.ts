import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSurfaceDispositions } from "../../scripts/localization-surfaces.js";

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
        excludedRoots: ["product/generated"],
      },
    ],
    surfaces,
  };
}

const adoptedSurface = {
  id: "wizard-core",
  owner: "wizard",
  source: "product/en.json",
  disposition: "adopted",
  catalogArea: "wizard-core",
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openclaw-localization-surfaces-"));
  await writeJson("product/en.json", { messages: {} });
  await writeJson("product/generated/zh-CN.json", { messages: {} });
  await writeJson("registry.json", registry([adoptedSurface]));
  await writeJson("catalogs.json", {
    schemaVersion: 1,
    areas: [{ id: "wizard-core", source: "product/en.json" }],
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("localization surface dispositions", () => {
  it("accepts an adopted owner-enumerated source and excludes generated targets", async () => {
    await expect(
      checkSurfaceDispositions({
        root,
        registryPath: "registry.json",
        catalogRegistryPath: "catalogs.json",
      }),
    ).resolves.toBe(1);
  });

  it("blocks a newly enumerated source before it has a disposition", async () => {
    await writeJson("product/new-surface.json", { messages: {} });

    await expect(
      checkSurfaceDispositions({
        root,
        registryPath: "registry.json",
        catalogRegistryPath: "catalogs.json",
      }),
    ).rejects.toThrow(
      "new product-string surface product/new-surface.json from adapter wizard-catalog-sources has no localization disposition",
    );
  });

  it("accepts a deferred new source with a named owner and rationale", async () => {
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
          rationale: "Catalog ownership will land with the owning wizard slice.",
        },
      ]),
    );

    await expect(
      checkSurfaceDispositions({
        root,
        registryPath: "registry.json",
        catalogRegistryPath: "catalogs.json",
      }),
    ).resolves.toBe(2);
  });

  it("rejects a deferred source without an owner rationale", async () => {
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
        },
      ]),
    );

    await expect(
      checkSurfaceDispositions({
        root,
        registryPath: "registry.json",
        catalogRegistryPath: "catalogs.json",
      }),
    ).rejects.toThrow("surfaces[1].rationale must be a non-empty string");
  });

  it("rejects a disposition assigned to a different semantic owner", async () => {
    await writeJson("registry.json", registry([{ ...adoptedSurface, owner: "other-owner" }]));

    await expect(
      checkSurfaceDispositions({
        root,
        registryPath: "registry.json",
        catalogRegistryPath: "catalogs.json",
      }),
    ).rejects.toThrow(
      "surface wizard-core owner other-owner does not match adapter wizard-catalog-sources owner wizard",
    );
  });

  it("rejects an adopted source that does not match its catalog area", async () => {
    await writeJson("catalogs.json", {
      schemaVersion: 1,
      areas: [{ id: "wizard-core", source: "product/other.json" }],
    });

    await expect(
      checkSurfaceDispositions({
        root,
        registryPath: "registry.json",
        catalogRegistryPath: "catalogs.json",
      }),
    ).rejects.toThrow("does not match catalog area wizard-core source product/other.json");
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
          rationale: "Temporary baseline.",
        },
      ]),
    );

    await expect(
      checkSurfaceDispositions({
        root,
        registryPath: "registry.json",
        catalogRegistryPath: "catalogs.json",
      }),
    ).rejects.toThrow("surface stale-surface declares undiscovered source product/missing.json");
  });
});
