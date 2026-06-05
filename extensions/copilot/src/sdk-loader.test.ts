// Copilot tests cover sdk loader plugin behavior.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPILOT_SDK_FALLBACK_DIR,
  COPILOT_SDK_SPEC,
  resetCopilotSdkCacheForTests,
  loadCopilotSdk,
  resolveCopilotSdkFallbackDir,
} from "./sdk-loader.js";

const FAKE_SDK = {
  CopilotClient: class FakeCopilotClient {
    _fake = true;
  },
} as unknown as typeof import("@github/copilot-sdk");

describe("sdk-loader", () => {
  beforeEach(() => {
    resetCopilotSdkCacheForTests();
  });

  it("returns the primary import when it succeeds", async () => {
    const primaryImport = vi.fn(async () => FAKE_SDK);
    const fallbackImport = vi.fn(async () => {
      throw new Error("should not be called");
    });

    const sdk = await loadCopilotSdk({
      cache: false,
      fallbackDir: "/dev/null/does-not-exist",
      primaryImport,
      fallbackImport,
    });

    expect(sdk).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(1);
    expect(fallbackImport).not.toHaveBeenCalled();
  });

  it("falls back to the on-demand install location when primary import fails", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "copilot-sdk-loader-"));
    try {
      // Materialize the fallback path so the existsSync check passes.
      const fallbackPath = path.join(tmp, "node_modules", "@github", "copilot-sdk");
      mkdirSync(fallbackPath, { recursive: true });
      writeFileSync(path.join(fallbackPath, "index.js"), "// placeholder");

      const primaryImport = vi.fn(async () => {
        const err = new Error("Cannot find module '@github/copilot-sdk'") as Error & {
          code: string;
        };
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      });
      const fallbackImport = vi.fn(async (abs: string) => {
        expect(abs).toBe(fallbackPath);
        return FAKE_SDK;
      });

      const sdk = await loadCopilotSdk({
        cache: false,
        fallbackDir: tmp,
        primaryImport,
        fallbackImport,
      });

      expect(sdk).toBe(FAKE_SDK);
      expect(primaryImport).toHaveBeenCalledTimes(1);
      expect(fallbackImport).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("default fallback importer resolves and imports the installed SDK entry", async () => {
    // Exercise the real default fallback importer (no fallbackImport injection)
    // to prove it imports a concrete entry file rather than the package
    // directory, which Node ESM would reject with ERR_UNSUPPORTED_DIR_IMPORT.
    const tmp = mkdtempSync(path.join(tmpdir(), "copilot-sdk-loader-default-"));
    try {
      const pkgDir = path.join(tmp, "node_modules", "@github", "copilot-sdk");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@github/copilot-sdk",
          version: "0.0.0-test",
          main: "./index.cjs",
        }),
      );
      writeFileSync(
        path.join(pkgDir, "index.cjs"),
        "module.exports = { openclawDefaultImporterSentinel: true };",
      );

      const primaryImport = vi.fn(async () => {
        const err = new Error("Cannot find module '@github/copilot-sdk'") as Error & {
          code: string;
        };
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      });

      const sdk = (await loadCopilotSdk({
        cache: false,
        fallbackDir: tmp,
        primaryImport,
        // Intentionally NOT injecting fallbackImport; exercise the default.
      })) as unknown as { openclawDefaultImporterSentinel?: boolean };

      expect(sdk.openclawDefaultImporterSentinel).toBe(true);
      expect(primaryImport).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws an actionable error with plugin install instructions when both probes fail", async () => {
    const primaryImport = vi.fn(async () => {
      throw new Error("Cannot find module '@github/copilot-sdk'");
    });
    const fallbackImport = vi.fn(async () => {
      throw new Error("should not be called when fallback dir does not exist");
    });

    await expect(
      loadCopilotSdk({
        cache: false,
        fallbackDir: path.join(tmpdir(), "copilot-sdk-loader-missing-" + Date.now()),
        primaryImport,
        fallbackImport,
      }),
    ).rejects.toMatchObject({
      code: "COPILOT_SDK_MISSING",
      message: expect.stringContaining("openclaw plugins install @openclaw/copilot"),
    });

    expect(fallbackImport).not.toHaveBeenCalled();
  });

  it("error message includes the fallback path and underlying primary error", async () => {
    const primaryImport = vi.fn(async () => {
      throw new Error("primary boom");
    });

    const fallbackDir = path.join(tmpdir(), "copilot-sdk-loader-missing-" + Date.now());
    let captured: Error | undefined;
    try {
      await loadCopilotSdk({
        cache: false,
        fallbackDir,
        primaryImport,
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    const message = captured?.message ?? "";
    expect(message).toContain("primary boom");
    expect(message).toContain(path.join(fallbackDir, "node_modules", "@github", "copilot-sdk"));
    expect(message).toContain(COPILOT_SDK_SPEC);
    expect(message).toContain("openclaw plugins install @openclaw/copilot");
  });

  it("caches successful loads across calls when cache is enabled", async () => {
    const primaryImport = vi.fn(async () => FAKE_SDK);

    const a = await loadCopilotSdk({ primaryImport, fallbackDir: "/dev/null/does-not-exist" });
    const b = await loadCopilotSdk({ primaryImport, fallbackDir: "/dev/null/does-not-exist" });

    expect(a).toBe(FAKE_SDK);
    expect(b).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(1);
  });

  it("does not poison the cache after a failed load", async () => {
    const primaryImport = vi
      .fn<typeof Promise>()
      .mockRejectedValueOnce(new Error("first boom"))
      .mockResolvedValueOnce(FAKE_SDK);

    await expect(
      loadCopilotSdk({
        primaryImport: primaryImport as unknown as () => Promise<
          typeof import("@github/copilot-sdk")
        >,
        fallbackDir: "/dev/null/does-not-exist",
      }),
    ).rejects.toBeInstanceOf(Error);

    const sdk = await loadCopilotSdk({
      primaryImport: primaryImport as unknown as () => Promise<
        typeof import("@github/copilot-sdk")
      >,
      fallbackDir: "/dev/null/does-not-exist",
    });
    expect(sdk).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(2);
  });

  it("default fallback dir points at ~/.openclaw/npm-runtime/copilot", () => {
    expect(COPILOT_SDK_FALLBACK_DIR).toMatch(/\.openclaw[\\/]+npm-runtime[\\/]+copilot$/);
  });

  it("resolves the fallback dir from OPENCLAW_STATE_DIR for relocated profiles", () => {
    expect(
      resolveCopilotSdkFallbackDir({
        ...process.env,
        OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
      }),
    ).toBe(path.join("/tmp/openclaw-state", "npm-runtime", "copilot"));
  });

  afterEach(() => {
    resetCopilotSdkCacheForTests();
  });
});

describe("sdk dependency constants", () => {
  it("COPILOT_SDK_FALLBACK_DIR keeps the legacy fallback path stable", () => {
    expect(COPILOT_SDK_FALLBACK_DIR).toMatch(/\.openclaw[\\/]+npm-runtime[\\/]+copilot$/);
  });
  it("COPILOT_SDK_SPEC pins the canonical SDK spec", () => {
    expect(COPILOT_SDK_SPEC).toBe("@github/copilot-sdk@1.0.0-beta.9");
  });
});
