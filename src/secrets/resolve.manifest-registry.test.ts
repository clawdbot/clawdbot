import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveSecretRefString } from "./resolve.js";

const mocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadPluginManifestRegistry: vi.fn(() => {
    throw new Error("unexpected manifest registry rediscovery");
  }),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

function createPluginManagedSecretProviderFixture(): {
  config: OpenClawConfig;
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">;
  rootDir: string;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-secret-provider-"));
  fs.chmodSync(rootDir, 0o700);
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
  const resolverPath = path.join(rootDir, "resolve.mjs");
  fs.writeFileSync(
    resolverPath,
    [
      "import process from 'node:process';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(input);",
      "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values: Object.fromEntries(request.ids.map((id) => [id, `value:${id}`])) }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(resolverPath, 0o600);
  const manifestRegistry = {
    plugins: [
      {
        id: "vault-secrets",
        rootDir,
        origin: "global",
        channels: [],
        providers: [],
        cliBackends: [],
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "${node}",
            args: ["./resolve.mjs"],
          },
        },
      },
    ],
  } as unknown as Pick<PluginManifestRegistry, "plugins">;
  const config = {
    secrets: {
      providers: {
        vault: {
          source: "exec",
          pluginIntegration: {
            pluginId: "vault-secrets",
            integrationId: "vault",
          },
        },
      },
    },
  } as OpenClawConfig;
  return { config, manifestRegistry, rootDir };
}

describe("resolveSecretRefString manifest registry reuse", () => {
  afterEach(() => {
    mocks.getCurrentPluginMetadataSnapshot.mockReset();
    mocks.loadPluginManifestRegistry.mockClear();
  });

  it("uses an explicit manifest registry without rediscovering plugin manifests", async () => {
    const { config, manifestRegistry, rootDir } = createPluginManagedSecretProviderFixture();
    try {
      await expect(
        resolveSecretRefString(
          { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
          {
            config,
            manifestRegistry,
          },
        ),
      ).resolves.toBe("value:providers/openrouter/apiKey");
      expect(mocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
      expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses the current lifecycle metadata snapshot before falling back to manifest discovery", async () => {
    const { config, manifestRegistry, rootDir } = createPluginManagedSecretProviderFixture();
    const env = { HOME: rootDir } as NodeJS.ProcessEnv;
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ manifestRegistry });
    try {
      await expect(
        resolveSecretRefString(
          { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
          {
            config,
            env,
          },
        ),
      ).resolves.toBe("value:providers/openrouter/apiKey");
      expect(mocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
        config,
        env,
        allowWorkspaceScopedSnapshot: true,
      });
      expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
