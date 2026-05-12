import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

function mockMissingSqliteVecPackage(): void {
  vi.doMock("sqlite-vec", () => {
    const err = new Error("Cannot find package 'sqlite-vec' imported from sqlite-vec.test.ts");
    Object.assign(err, { code: "ERR_MODULE_NOT_FOUND" });
    throw err;
  });
}

function mockPlatformVariantResolver(
  value: { pkg: string; extensionPath: string } | undefined,
): void {
  vi.doMock("./sqlite-vec-platform-variant.js", () => ({
    resolveSqliteVecPlatformVariant: () => value,
  }));
}

async function importLoader() {
  return import("./sqlite-vec.js");
}

afterEach(() => {
  vi.doUnmock("sqlite-vec");
  vi.doUnmock("./sqlite-vec-platform-variant.js");
  vi.resetModules();
});

const CURRENT_PLATFORM_VARIANTS: Readonly<
  Record<string, { readonly pkg: string; readonly file: string } | undefined>
> = {
  "linux-x64": { pkg: "sqlite-vec-linux-x64", file: "vec0.so" },
  "linux-arm64": { pkg: "sqlite-vec-linux-arm64", file: "vec0.so" },
  "darwin-x64": { pkg: "sqlite-vec-darwin-x64", file: "vec0.dylib" },
  "darwin-arm64": { pkg: "sqlite-vec-darwin-arm64", file: "vec0.dylib" },
  "win32-x64": { pkg: "sqlite-vec-windows-x64", file: "vec0.dll" },
};

function isMissingModuleError(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

describe("loadSqliteVecExtension", () => {
  it("loads explicit extensionPath without importing bundled sqlite-vec", async () => {
    mockMissingSqliteVecPackage();
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    await expect(
      loadSqliteVecExtension({
        db: db as never,
        extensionPath: "/opt/openclaw/sqlite-vec.so",
      }),
    ).resolves.toEqual({ ok: true, extensionPath: "/opt/openclaw/sqlite-vec.so" });
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith("/opt/openclaw/sqlite-vec.so");
  });

  it("returns a valid memorySearch extensionPath hint when sqlite-vec is absent", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver(undefined);
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^sqlite-vec package is not installed\. Set agents\.defaults\.memorySearch\.store\.vector\.extensionPath, or an agent-specific memorySearch\.store\.vector\.extensionPath, to a sqlite-vec loadable extension path\. Original error: (?:\[vitest\] There was an error when mocking a module\. If you are using "vi\.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file\. Read more: https:\/\/vitest\.dev\/api\/vi\.html#vi-mock \| )?Cannot find package 'sqlite-vec' imported from sqlite-vec\.test\.ts$/u,
      ),
    });
    expect(result.error).not.toContain("memory.store.vector.extensionPath");
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).not.toHaveBeenCalled();
  });

  it("falls back to the platform-specific sqlite-vec variant when only that package is installed", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver({
      pkg: "sqlite-vec-linux-x64",
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: true,
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith(
      "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    );
  });

  it("resolves the installed platform variant through its exported vec0 subpath", async () => {
    const entry = CURRENT_PLATFORM_VARIANTS[`${process.platform}-${process.arch}`];
    if (!entry) {
      return;
    }

    const require_ = createRequire(import.meta.url);
    let expectedPath: string;
    try {
      expectedPath = require_.resolve(`${entry.pkg}/${entry.file}`);
    } catch (err) {
      if (isMissingModuleError(err)) {
        return;
      }
      throw err;
    }

    const { resolveSqliteVecPlatformVariant } = await import("./sqlite-vec-platform-variant.js");

    expect(resolveSqliteVecPlatformVariant()).toEqual({
      pkg: entry.pkg,
      extensionPath: expectedPath,
    });
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("preserves the extensionPath config hint when the platform variant loadExtension call throws", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver({
      pkg: "sqlite-vec-linux-x64",
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn().mockImplementation(() => {
        throw new Error("dlopen failed: file not found");
      }),
    };

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: false,
      error:
        "sqlite-vec platform variant sqlite-vec-linux-x64 failed to load from /install/node_modules/sqlite-vec-linux-x64/vec0.so. Set agents.defaults.memorySearch.store.vector.extensionPath, or an agent-specific memorySearch.store.vector.extensionPath, to a sqlite-vec loadable extension path. Original error: dlopen failed: file not found",
    });
  });
});
