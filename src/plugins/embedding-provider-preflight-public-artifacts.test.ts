import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryEmbeddingProviderStartupInspector } from "./embedding-provider-preflight-public-artifacts.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeExternalInspector(): { pluginRoot: string; sentinelPath: string } {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-embedding-preflight-"));
  roots.push(pluginRoot);
  const sentinelPath = path.join(pluginRoot, "loaded");
  fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n');
  fs.writeFileSync(
    path.join(pluginRoot, "embedding-provider-preflight-api.js"),
    [
      'require("node:fs").writeFileSync(' + JSON.stringify(sentinelPath) + ', "loaded");',
      "module.exports = {",
      "  embeddingProviderStartupInspectors: [",
      "    {",
      '      id: "local",',
      '      inspectStartupPrerequisites: () => ({ status: "ready" }),',
      "    },",
      "  ],",
      "};",
      "",
    ].join("\n"),
  );
  return { pluginRoot, sentinelPath };
}

const localConfig = {
  memory: {
    search: {
      provider: "local",
      fallback: "none",
    },
  },
};

describe("embedding provider preflight public artifacts", () => {
  it("resolves the bundled local inspector without plugin runtime activation", () => {
    const inspector = resolveMemoryEmbeddingProviderStartupInspector({
      providerId: "local",
      config: localConfig,
    });

    expect(inspector?.id).toBe("local");
    expect(
      inspector?.inspectStartupPrerequisites?.({
        config: localConfig,
        agentDir: "/tmp/openclaw-agent",
        provider: "local",
        model: "",
      }),
    ).toEqual({
      status: "blocked",
      issues: [
        expect.objectContaining({
          code: "managed-server-config-missing",
        }),
      ],
    });
  });

  it("does not execute a host-verified official external artifact", () => {
    const { pluginRoot, sentinelPath } = writeExternalInspector();
    expect(
      resolveMemoryEmbeddingProviderStartupInspector({
        providerId: "local",
        config: {
          ...localConfig,
          plugins: { entries: { "llama-cpp": { enabled: true } } },
        },
        manifestRegistry: {
          plugins: [
            {
              id: "llama-cpp",
              origin: "global",
              rootDir: pluginRoot,
              trustedOfficialInstall: true,
              contracts: { embeddingProviders: ["local"] },
            } as never,
          ],
        },
      }),
    ).toBeUndefined();
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it("does not load an inspector from an untrusted external owner", () => {
    const { pluginRoot, sentinelPath } = writeExternalInspector();
    expect(
      resolveMemoryEmbeddingProviderStartupInspector({
        providerId: "local",
        config: {
          ...localConfig,
          plugins: { entries: { "llama-cpp": { enabled: true } } },
        },
        manifestRegistry: {
          plugins: [
            {
              id: "llama-cpp",
              origin: "global",
              rootDir: pluginRoot,
              contracts: { embeddingProviders: ["local"] },
            } as never,
          ],
        },
      }),
    ).toBeUndefined();
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it("does not load an inspector for an owner blocked by Gateway startup policy", () => {
    const { pluginRoot, sentinelPath } = writeExternalInspector();
    expect(
      resolveMemoryEmbeddingProviderStartupInspector({
        providerId: "local",
        config: {
          ...localConfig,
          plugins: { entries: { "llama-cpp": { enabled: false } } },
        },
        manifestRegistry: {
          plugins: [
            {
              id: "llama-cpp",
              origin: "global",
              rootDir: pluginRoot,
              trustedOfficialInstall: true,
              contracts: { embeddingProviders: ["local"] },
            } as never,
          ],
        },
      }),
    ).toBeUndefined();
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it.each([
    {
      name: "entry disabled",
      plugins: { entries: { "llama-cpp": { enabled: false } } },
    },
    {
      name: "denylisted",
      plugins: { deny: ["llama-cpp"] },
    },
    {
      name: "excluded by allowlist",
      plugins: { allow: ["memory-core"] },
    },
    {
      name: "plugins globally disabled",
      plugins: { enabled: false },
    },
  ])("does not expose the bundled inspector when its owner is $name", ({ plugins }) => {
    expect(
      resolveMemoryEmbeddingProviderStartupInspector({
        providerId: "local",
        config: {
          ...localConfig,
          plugins,
        },
      }),
    ).toBeUndefined();
  });

  it("does not expose unsupported provider runtime through the static path", () => {
    expect(
      resolveMemoryEmbeddingProviderStartupInspector({
        providerId: "openai",
        config: {
          memory: {
            search: {
              provider: "openai",
              fallback: "none",
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});
