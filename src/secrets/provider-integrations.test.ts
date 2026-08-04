/** Tests plugin-provided secret provider integration presets and resolution. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import {
  listSecretProviderIntegrationPresets,
  resolveSecretProviderIntegrationConfig,
} from "./provider-integrations.js";
import { resolveSecretRefString } from "./resolve.js";
import { withSecureTestNodeExecPath } from "./test-node-command.test-support.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-provider-integrations-"));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function makeSecureDir(dir: string): void {
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o700);
}

function writeSecureFile(file: string, contents: string): void {
  fs.writeFileSync(file, contents, "utf8");
  fs.chmodSync(file, 0o600);
}

function writePluginManifest(rootDir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      ...manifest,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    }),
    "utf8",
  );
}

function createCandidate(
  rootDir: string,
  idHint: string,
  origin: PluginOrigin = "global",
): PluginCandidate {
  return {
    idHint,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin,
  };
}

function loadTestRegistry(
  rootDir: string,
  idHint: string,
  origin: PluginOrigin = "global",
): PluginManifestRegistry {
  return loadPluginManifestRegistry({
    candidates: [createCandidate(rootDir, idHint, origin)],
  });
}

function pluginIntegrationProviderConfig(pluginId: string, integrationId: string) {
  return {
    source: "exec" as const,
    pluginIntegration: {
      pluginId,
      integrationId,
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret provider integration presets", () => {
  it("materializes plugin manifest exec providers without provider-specific core code", () => {
    const rootDir = makeTempDir();
    makeSecureDir(path.join(rootDir, "bin"));
    writeSecureFile(path.join(rootDir, "bin", "resolve.mjs"), "process.stdin.resume();\n");
    writePluginManifest(rootDir, {
      id: "acme-secrets",
      name: "Acme Secrets",
      secretProviderIntegrations: {
        acme: {
          providerAlias: "acme",
          displayName: "Acme Vault",
          description: "Acme exec resolver",
          source: "exec",
          command: "${node}",
          args: ["./bin/resolve.mjs", "--profile", "work"],
          timeoutMs: 3000,
          noOutputTimeoutMs: 3000,
          maxOutputBytes: 4096,
          passEnv: ["HOME"],
          env: {
            ACME_PROFILE: "work",
          },
          jsonOnly: false,
        },
      },
    });

    const registry = loadTestRegistry(rootDir, "acme-secrets");

    expect(registry.diagnostics).toEqual([]);
    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "acme",
        pluginId: "acme-secrets",
        providerAlias: "acme",
        displayName: "Acme Vault",
        description: "Acme exec resolver",
        providerConfig: pluginIntegrationProviderConfig("acme-secrets", "acme"),
      },
    ]);
    expect(
      resolveSecretProviderIntegrationConfig({
        manifestRegistry: registry,
        providerAlias: "acme",
        providerConfig: pluginIntegrationProviderConfig("acme-secrets", "acme"),
      }),
    ).toEqual({
      ok: true,
      providerConfig: {
        source: "exec",
        command: process.execPath,
        args: [fs.realpathSync(path.join(rootDir, "bin", "resolve.mjs")), "--profile", "work"],
        timeoutMs: 3000,
        noOutputTimeoutMs: 3000,
        maxOutputBytes: 4096,
        passEnv: ["HOME"],
        env: {
          ACME_PROFILE: "work",
        },
        trustedDirs: [path.dirname(process.execPath), rootDir],
        jsonOnly: false,
      },
    });
  });

  it("normalizes manifest exec provider options to SecretRef provider schema limits", () => {
    const rootDir = makeTempDir();
    writeSecureFile(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n");
    writePluginManifest(rootDir, {
      id: "bounded-secrets",
      secretProviderIntegrations: {
        bounded: {
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs", "ok", "x".repeat(1025)],
          timeoutMs: 120001,
          noOutputTimeoutMs: 1.5,
          maxOutputBytes: 20 * 1024 * 1024 + 1,
          passEnv: ["GOOD_ENV", "bad-env"],
        },
      },
    });

    const registry = loadTestRegistry(rootDir, "bounded-secrets");

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "bounded",
        pluginId: "bounded-secrets",
        providerAlias: "bounded",
        displayName: "bounded",
        providerConfig: pluginIntegrationProviderConfig("bounded-secrets", "bounded"),
      },
    ]);
    expect(
      resolveSecretProviderIntegrationConfig({
        manifestRegistry: registry,
        providerAlias: "bounded",
        providerConfig: pluginIntegrationProviderConfig("bounded-secrets", "bounded"),
      }),
    ).toEqual({
      ok: true,
      providerConfig: {
        source: "exec",
        command: process.execPath,
        args: [fs.realpathSync(path.join(rootDir, "resolve.mjs")), "ok"],
        trustedDirs: [path.dirname(process.execPath), rootDir],
        passEnv: ["GOOD_ENV"],
      },
    });
  });

  it("skips presets whose provider alias cannot be used as a SecretRef provider", () => {
    const rootDir = makeTempDir();
    writePluginManifest(rootDir, {
      id: "bad-secrets",
      secretProviderIntegrations: {
        bad: {
          providerAlias: "../bad",
          source: "exec",
          command: "${node}",
        },
      },
    });

    const registry = loadTestRegistry(rootDir, "bad-secrets");

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });

  it("skips presets whose persisted plugin integration IDs would violate config schema limits", () => {
    const rootDir = makeTempDir();
    const longPluginRootDir = makeTempDir();
    const longPluginId = `plugin-${"x".repeat(129)}`;
    const longIntegrationId = `integration-${"x".repeat(129)}`;
    fs.writeFileSync(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n", "utf8");
    fs.writeFileSync(
      path.join(longPluginRootDir, "resolve.mjs"),
      "process.stdin.resume();\n",
      "utf8",
    );
    writePluginManifest(rootDir, {
      id: "long-integration-secrets",
      secretProviderIntegrations: {
        [longIntegrationId]: {
          providerAlias: "short-alias",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });
    writePluginManifest(longPluginRootDir, {
      id: longPluginId,
      secretProviderIntegrations: {
        vault: {
          providerAlias: "short-plugin-alias",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });

    const registry = loadPluginManifestRegistry({
      candidates: [
        createCandidate(rootDir, "long-integration-secrets"),
        createCandidate(longPluginRootDir, longPluginId),
      ],
    });

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });

  it.each<PluginOrigin>(["bundled", "global"])(
    "skips non-node manifest preset commands for %s plugin roots",
    (origin) => {
      const rootDir = makeTempDir();
      fs.mkdirSync(path.join(rootDir, "bin"));
      writePluginManifest(rootDir, {
        id: `${origin}-secrets`,
        ...(origin === "bundled" ? { enabledByDefault: true } : {}),
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "./bin/vault-resolver",
          },
        },
      });

      const registry = loadTestRegistry(rootDir, `${origin}-secrets`, origin);

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
    },
  );

  it("skips presets from disabled installed plugins", () => {
    const rootDir = makeTempDir();
    writeSecureFile(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n");
    writePluginManifest(rootDir, {
      id: "disabled-secrets",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });

    const registry = loadPluginManifestRegistry({
      candidates: [createCandidate(rootDir, "disabled-secrets", "global")],
      config: {
        plugins: {
          entries: {
            "disabled-secrets": {
              enabled: false,
            },
          },
        },
      },
    });

    expect(
      listSecretProviderIntegrationPresets({
        manifestRegistry: registry,
        config: {
          plugins: {
            entries: {
              "disabled-secrets": {
                enabled: false,
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("applies plugin id aliases when filtering disabled presets", () => {
    const rootDir = makeTempDir();
    writeSecureFile(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n");
    writePluginManifest(rootDir, {
      id: "openai",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });
    const config = {
      plugins: {
        entries: {
          openai: {
            enabled: false,
          },
        },
      },
    };
    const registry = loadPluginManifestRegistry({
      candidates: [createCandidate(rootDir, "openai", "global")],
      config,
    });

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry, config })).toEqual(
      [],
    );
  });

  it("exposes bundled presets enabled by platform default", () => {
    const rootDir = makeTempDir();
    writeSecureFile(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n");
    writePluginManifest(rootDir, {
      id: "platform-secrets",
      enabledByDefaultOnPlatforms: [process.platform],
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });
    const registry = loadTestRegistry(rootDir, "platform-secrets", "bundled");

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "vault",
        pluginId: "platform-secrets",
        providerAlias: "vault",
        displayName: "vault",
        providerConfig: pluginIntegrationProviderConfig("platform-secrets", "vault"),
      },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "materializes node presets from symlinked plugin roots",
    () => {
      const rootDir = makeTempDir();
      const linkParent = makeTempDir();
      const linkRoot = path.join(linkParent, "plugin-link");
      writeSecureFile(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n");
      writePluginManifest(rootDir, {
        id: "linked-secrets",
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "${node}",
            args: ["./resolve.mjs"],
          },
        },
      });
      fs.symlinkSync(rootDir, linkRoot);

      const registry = loadTestRegistry(linkRoot, "linked-secrets", "global");

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
        {
          id: "vault",
          pluginId: "linked-secrets",
          providerAlias: "vault",
          displayName: "vault",
          providerConfig: pluginIntegrationProviderConfig("linked-secrets", "vault"),
        },
      ]);
    },
  );

  it.each<PluginOrigin>(["workspace", "config"])(
    "skips secret provider presets from %s plugin roots",
    (origin) => {
      const rootDir = makeTempDir();
      writePluginManifest(rootDir, {
        id: `${origin}-secrets`,
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "${node}",
            args: ["./resolve.mjs"],
          },
        },
      });

      const registry = loadTestRegistry(rootDir, `${origin}-secrets`, origin);

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
    },
  );

  it("resolves a node-based plugin preset with plugin trusted dirs", async () => {
    const rootDir = makeTempDir();
    const resolverPath = path.join(rootDir, "bin", "resolve.mjs");
    makeSecureDir(path.dirname(resolverPath));
    writeSecureFile(
      resolverPath,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(input);",
        "  const values = Object.fromEntries(request.ids.map((id) => [id, `value:${id}`]));",
        "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
        "});",
      ].join("\n"),
    );
    writePluginManifest(rootDir, {
      id: "vault-secrets",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./bin/resolve.mjs"],
          allowInsecurePath: true,
        },
      },
    });

    await withSecureTestNodeExecPath(async () => {
      const registry = loadTestRegistry(rootDir, "vault-secrets", "global");
      const [preset] = listSecretProviderIntegrationPresets({ manifestRegistry: registry });
      if (!preset) {
        throw new Error("Expected vault preset");
      }

      expect(preset.providerConfig).toEqual({
        source: "exec",
        pluginIntegration: {
          pluginId: "vault-secrets",
          integrationId: "vault",
        },
      });
      await expect(
        resolveSecretRefString(
          { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
          {
            config: {
              secrets: {
                providers: {
                  vault: preset.providerConfig,
                },
              },
            },
            manifestRegistry: registry,
          },
        ),
      ).resolves.toBe("value:providers/openrouter/apiKey");
    });
  });

  it("fails closed when a plugin-managed provider is disabled", async () => {
    const rootDir = makeTempDir();
    const resolverPath = path.join(rootDir, "resolve.mjs");
    fs.writeFileSync(resolverPath, "process.stdin.resume();\n", "utf8");
    writePluginManifest(rootDir, {
      id: "revoked-secrets",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });
    const config = {
      plugins: {
        entries: {
          "revoked-secrets": {
            enabled: false,
          },
        },
      },
      secrets: {
        providers: {
          vault: pluginIntegrationProviderConfig("revoked-secrets", "vault"),
        },
      },
    };
    const registry = loadPluginManifestRegistry({
      candidates: [createCandidate(rootDir, "revoked-secrets", "global")],
      config,
    });

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
        {
          config,
          manifestRegistry: registry,
        },
      ),
    ).rejects.toThrow("plugin integration is unavailable");
  });

  it("does not materialize non-node integrations from registry records", () => {
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, "bin"));
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(rootDir, "bin", "resolve"), "exit 0\n", "utf8");
    const manifestRegistry = {
      plugins: [
        {
          id: "raw-secrets",
          rootDir,
          origin: "global",
          channels: [],
          providers: [],
          cliBackends: [],
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              source: "exec",
              command: "./bin/resolve",
            },
          },
        },
      ],
    } as unknown as Pick<PluginManifestRegistry, "plugins">;

    expect(
      resolveSecretProviderIntegrationConfig({
        manifestRegistry,
        providerAlias: "vault",
        providerConfig: pluginIntegrationProviderConfig("raw-secrets", "vault"),
      }),
    ).toEqual({
      ok: false,
      reason: 'plugin "raw-secrets" integration "vault" could not be materialized',
    });
  });

  it("skips node presets without a plugin-root relative entrypoint arg", () => {
    const rootDir = makeTempDir();
    writePluginManifest(rootDir, {
      id: "bad-trust-secrets",
      secretProviderIntegrations: {
        bad: {
          source: "exec",
          command: "${node}",
          args: ["--import", "./bin/hook.mjs", "./bin/resolve.mjs"],
        },
      },
    });

    const registry = loadTestRegistry(rootDir, "bad-trust-secrets");

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "skips node presets whose entrypoint symlink leaves the plugin root",
    () => {
      const rootDir = makeTempDir();
      const outsideDir = makeTempDir();
      fs.mkdirSync(path.join(rootDir, "bin"));
      fs.writeFileSync(path.join(outsideDir, "resolve.mjs"), "process.stdin.resume();\n");
      fs.symlinkSync(
        path.join(outsideDir, "resolve.mjs"),
        path.join(rootDir, "bin", "resolve.mjs"),
      );
      writePluginManifest(rootDir, {
        id: "symlink-secrets",
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "${node}",
            args: ["./bin/resolve.mjs"],
          },
        },
      });

      const registry = loadTestRegistry(rootDir, "symlink-secrets");

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("allows node presets from symlinked plugin roots", () => {
    const parentDir = makeTempDir();
    const realRoot = path.join(parentDir, "real-plugin");
    const linkedRoot = path.join(parentDir, "linked-plugin");
    makeSecureDir(realRoot);
    fs.symlinkSync(realRoot, linkedRoot, "dir");
    makeSecureDir(path.join(realRoot, "bin"));
    writeSecureFile(path.join(realRoot, "bin", "resolve.mjs"), "process.stdin.resume();\n");
    writePluginManifest(realRoot, {
      id: "linked-root-secrets",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./bin/resolve.mjs"],
        },
      },
    });

    const registry = loadTestRegistry(linkedRoot, "linked-root-secrets");

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "vault",
        pluginId: "linked-root-secrets",
        providerAlias: "vault",
        displayName: "vault",
        providerConfig: pluginIntegrationProviderConfig("linked-root-secrets", "vault"),
      },
    ]);
    const resolved = resolveSecretProviderIntegrationConfig({
      manifestRegistry: registry,
      providerAlias: "vault",
      providerConfig: pluginIntegrationProviderConfig("linked-root-secrets", "vault"),
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.providerConfig.args?.[0]).toBe(
        fs.realpathSync(path.join(realRoot, "bin", "resolve.mjs")),
      );
    }
  });

  it.skipIf(process.platform === "win32")(
    "skips node presets whose entrypoint parent directory is writable by others",
    () => {
      const rootDir = makeTempDir();
      const binDir = path.join(rootDir, "bin");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "resolve.mjs"), "process.stdin.resume();\n");
      fs.chmodSync(binDir, 0o777);
      try {
        writePluginManifest(rootDir, {
          id: "writable-parent-secrets",
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              source: "exec",
              command: "${node}",
              args: ["./bin/resolve.mjs"],
            },
          },
        });

        const registry = loadTestRegistry(rootDir, "writable-parent-secrets");

        expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
      } finally {
        fs.chmodSync(binDir, 0o700);
      }
    },
  );
});
