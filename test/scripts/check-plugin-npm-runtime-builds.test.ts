import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPluginNpmRuntimeBuilds } from "../../scripts/check-plugin-npm-runtime-builds.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("plugin npm runtime build checks", () => {
  function writePackage(
    repoRoot: string,
    pluginId: string,
    release: { publishToClawHub?: boolean; publishToNpm?: boolean },
    extensions?: string[],
  ) {
    const packageDir = join(repoRoot, "extensions", pluginId);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: `@openclaw/${pluginId}`,
        version: "2026.6.2",
        type: "module",
        openclaw: {
          compat: {
            pluginApi: ">=2026.4.30",
          },
          extensions,
          release,
        },
      }),
    );
  }

  it("rejects publishable packages without a package-local runtime build plan", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-runtime-check-"));
    tempDirs.push(repoRoot);
    writePackage(repoRoot, "clawhub-only", { publishToClawHub: true }, ["./index.js"]);
    writePackage(repoRoot, "npm-javascript-only", { publishToNpm: true }, ["./index.js"]);

    await expect(
      checkPluginNpmRuntimeBuilds({
        repoRoot,
        packageDirs: ["extensions/clawhub-only"],
      }),
    ).rejects.toThrow("extensions/clawhub-only did not produce a package-local runtime build plan");
    await expect(
      checkPluginNpmRuntimeBuilds({
        repoRoot,
        packageDirs: ["extensions/npm-javascript-only"],
      }),
    ).rejects.toThrow(
      "extensions/npm-javascript-only did not produce a package-local runtime build plan",
    );
  });

  it("rejects invalid explicit package targets", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-runtime-check-"));
    tempDirs.push(repoRoot);
    writePackage(repoRoot, "not-publishable", {});

    await expect(
      checkPluginNpmRuntimeBuilds({
        repoRoot,
        packageDirs: ["extensions/not-publishable"],
      }),
    ).rejects.toThrow("did not produce a package-local runtime build plan");
    await expect(
      checkPluginNpmRuntimeBuilds({
        repoRoot,
        packageDirs: ["extensions/missing"],
      }),
    ).rejects.toThrow("did not produce a package-local runtime build plan");
  });

  it("builds a ClawHub-only TypeScript package runtime", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-runtime-check-"));
    tempDirs.push(repoRoot);
    writePackage(repoRoot, "clawhub-typescript", { publishToClawHub: true }, ["./index.ts"]);
    writeFileSync(
      join(repoRoot, "extensions", "clawhub-typescript", "index.ts"),
      "export default {};\n",
    );

    await expect(
      checkPluginNpmRuntimeBuilds({
        repoRoot,
        packageDirs: ["extensions/clawhub-typescript"],
      }),
    ).resolves.toEqual([
      {
        pluginDir: "clawhub-typescript",
        status: "built",
        entryCount: 1,
        copiedStaticAssets: [],
      },
    ]);
  });

  it("builds top-level public policy surfaces as standalone package artifacts", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-runtime-check-"));
    tempDirs.push(repoRoot);
    writePackage(repoRoot, "provider-plugin", { publishToNpm: true }, ["./index.ts"]);
    const packageDir = join(repoRoot, "extensions", "provider-plugin");
    writeFileSync(join(packageDir, "index.ts"), "export default {};\n");
    writeFileSync(
      join(packageDir, "provider-policy-api.ts"),
      "export function resolveThinkingProfile() { return { levels: [] }; }\n",
    );

    await expect(
      checkPluginNpmRuntimeBuilds({
        repoRoot,
        packageDirs: ["extensions/provider-plugin"],
      }),
    ).resolves.toEqual([
      {
        pluginDir: "provider-plugin",
        status: "built",
        entryCount: 2,
        copiedStaticAssets: [],
      },
    ]);
    expect(await import(join(packageDir, "dist", "provider-policy-api.js"))).toHaveProperty(
      "resolveThinkingProfile",
    );
  });
});
