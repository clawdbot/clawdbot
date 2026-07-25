import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleModelCatalogBundle,
  MODEL_CATALOG_MIN_MODELS,
  parsePublishModelCatalogArgs,
  readModelCatalogManifests,
  runPublishModelCatalog,
  summarizeModelCatalogBundle,
} from "../../scripts/publish-model-catalog.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureProvider(prefix: string, count: number) {
  return { models: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` })) };
}

function writeFixtureManifest(root: string, pluginId: string, providers: Record<string, unknown>) {
  const pluginDir = path.join(root, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId, modelCatalog: { providers } }, null, 2)}\n`,
  );
}

describe("publish model catalog", () => {
  it("assembles and validates fixture manifests at the 200-model floor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-"));
    tempDirs.push(root);
    writeFixtureManifest(root, "anthropic", { anthropic: fixtureProvider("claude", 100) });
    writeFixtureManifest(root, "openai", { openai: fixtureProvider("gpt", 100) });

    const bundle = await assembleModelCatalogBundle({
      manifests: readModelCatalogManifests({ rootDir: root }),
      generatedAt: Date.now(),
      sourceCommit: "fixture-sha",
    });
    expect(summarizeModelCatalogBundle(bundle)).toEqual({ providers: 2, models: 200 });
    expect(MODEL_CATALOG_MIN_MODELS).toBe(200);
  });

  it("rejects missing required providers, low counts, and invalid provider rows", async () => {
    const makeEntry = (providers: Record<string, unknown>) => [
      {
        pluginId: "fixture",
        manifestPath: "fixture.json",
        manifest: { modelCatalog: { providers } },
      },
    ];
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({ anthropic: fixtureProvider("claude", 200) }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow("anthropic and openai");
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({
          anthropic: fixtureProvider("claude", 100),
          openai: fixtureProvider("gpt", 99),
        }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow("below required floor 200");
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({
          anthropic: fixtureProvider("claude", 100),
          openai: { models: [{ id: "" }, ...fixtureProvider("gpt", 100).models] },
        }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow();
  });

  it("parses supported CLI arguments and rejects missing output", () => {
    expect(parsePublishModelCatalogArgs(["--dry-run", "--out", "ignored.json"])).toEqual({
      dryRun: true,
      out: "ignored.json",
    });
    expect(() => parsePublishModelCatalogArgs([])).toThrow("provide --out");
  });

  it("dry-runs the repository manifests without writing output", () => {
    const root = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-smoke-"));
    tempDirs.push(tempDir);
    const out = path.join(tempDir, "catalog.json");
    const result = spawnSync(
      process.execPath,
      ["scripts/publish-model-catalog.mjs", "--dry-run", "--out", out],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const stats = /dry-run schemaVersion=1 providers=39 models=(\d+)/u.exec(result.stdout);
    expect(stats).not.toBeNull();
    expect(Number(stats?.[1])).toBeGreaterThanOrEqual(MODEL_CATALOG_MIN_MODELS);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("uploads the fixed object key through wrangler when bucket credentials are present", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-r2-"));
    tempDirs.push(root);
    writeFixtureManifest(root, "anthropic", { anthropic: fixtureProvider("claude", 100) });
    writeFixtureManifest(root, "openai", { openai: fixtureProvider("gpt", 100) });
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    const result = await runPublishModelCatalog({
      args: ["--bucket", "catalog-bucket"],
      rootDir: root,
      now: () => Date.now(),
      sourceCommit: "fixture-sha",
      env: {
        R2_MODEL_CATALOG_ACCOUNT_ID: "account",
        R2_MODEL_CATALOG_API_TOKEN: "token",
        R2_MODEL_CATALOG_ENDPOINT: "https://api.cloudflare.com/client/v4",
      },
      spawnSyncImpl: (command, args, options) => {
        expect(fs.existsSync(args[args.indexOf("--file") + 1] ?? "")).toBe(true);
        calls.push({ command, args, env: options.env });
        return { status: 0, stdout: "uploaded\n", stderr: "" };
      },
    });

    expect(result.uploaded).toBe(true);
    expect(calls).toMatchObject([
      {
        command: "wrangler",
        args: [
          "r2",
          "object",
          "put",
          "catalog-bucket/models/v1/catalog.json",
          "--file",
          expect.any(String),
          "--remote",
        ],
        env: {
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
        },
      },
    ]);
  });

  it("ends failures with the stable wrapper marker", () => {
    const result = spawnSync(process.execPath, ["scripts/publish-model-catalog.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[publish-model-catalog] FAILED (exit 1)");
  });
});
