import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePrewarmedPluginCache } from "./prewarmed-plugin-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture() {
  const prefix = tempDirs.make("openclaw-runtime-plugin-cache-");
  const packageRoot = path.join(
    prefix,
    "tools",
    "node-v24.15.0",
    "lib",
    "node_modules",
    "openclaw",
  );
  const commit = "a".repeat(40);
  const cacheDir = path.join(prefix, "cache", "prewarmed-plugins", commit);
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const archiveFile = "openclaw-codex-2026.8.1.tgz";
  fs.writeFileSync(path.join(cacheDir, archiveFile), "archive\n");
  const archiveSHA256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(cacheDir, archiveFile)))
    .digest("hex");
  fs.writeFileSync(
    path.join(cacheDir, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      appVersion: "2026.8.1",
      gitCommit: commit,
      plugins: [
        {
          pluginId: "codex",
          packageName: "@openclaw/codex",
          packageVersion: "2026.8.1",
          npmSpec: "@openclaw/codex@2026.8.1",
          archiveFile,
          archiveSHA256,
        },
      ],
    })}\n`,
  );
  return { prefix, packageRoot, commit, cacheDir, archiveFile };
}

describe("prewarmed plugin cache resolver", () => {
  it("returns an exact cache hit for a stable official package", () => {
    const fixture = createFixture();
    expect(
      resolvePrewarmedPluginCache({
        pluginId: "codex",
        catalogNpmSpec: "@openclaw/codex",
        effectiveNpmSpec: "@openclaw/codex",
        packageRoot: fixture.packageRoot,
        stateDir: fixture.prefix,
        buildInfo: { version: "2026.8.1", commit: fixture.commit },
      }),
    ).toMatchObject({
      status: "hit",
      canonicalSpec: "@openclaw/codex@2026.8.1",
      packageVersion: "2026.8.1",
    });
  });

  it("misses absent entries and rejects tampering without registry fallback", () => {
    const fixture = createFixture();
    expect(
      resolvePrewarmedPluginCache({
        pluginId: "discord",
        catalogNpmSpec: "@openclaw/discord",
        effectiveNpmSpec: "@openclaw/discord",
        packageRoot: fixture.packageRoot,
        stateDir: fixture.prefix,
        buildInfo: { version: "2026.8.1", commit: fixture.commit },
      }),
    ).toEqual({ status: "miss" });

    fs.appendFileSync(path.join(fixture.cacheDir, fixture.archiveFile), "tampered");
    expect(
      resolvePrewarmedPluginCache({
        pluginId: "codex",
        catalogNpmSpec: "@openclaw/codex",
        effectiveNpmSpec: "@openclaw/codex",
        packageRoot: fixture.packageRoot,
        stateDir: fixture.prefix,
        buildInfo: { version: "2026.8.1", commit: fixture.commit },
      }),
    ).toMatchObject({ status: "invalid" });
  });

  it("misses selectors that do not request the cached stable version", () => {
    const fixture = createFixture();
    for (const effectiveNpmSpec of [
      "@openclaw/codex@2026.7.1",
      "@openclaw/codex@alpha",
      "@openclaw/codex@beta",
      "@openclaw/codex@next",
    ]) {
      expect(
        resolvePrewarmedPluginCache({
          pluginId: "codex",
          catalogNpmSpec: "@openclaw/codex",
          effectiveNpmSpec,
          packageRoot: fixture.packageRoot,
          stateDir: fixture.prefix,
          buildInfo: { version: "2026.8.1", commit: fixture.commit },
        }),
      ).toEqual({ status: "miss" });
    }
  });
});
