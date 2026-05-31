import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const manifestMocks = vi.hoisted(() => ({
  listPluginOriginsFromMetadataSnapshot: vi.fn(
    (snapshot: { plugins: Array<{ id: string; origin: string }> }) =>
      new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
  ),
  loadPluginMetadataSnapshot: vi.fn<() => { plugins: Array<{ id: string; origin: string }> }>(
    () => ({
      plugins: [],
    }),
  ),
}));

vi.mock("./runtime-manifest.runtime.js", () => ({
  listPluginOriginsFromMetadataSnapshot: manifestMocks.listPluginOriginsFromMetadataSnapshot,
  loadPluginMetadataSnapshot: manifestMocks.loadPluginMetadataSnapshot,
}));

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("prepareSecretsRuntimeSnapshot loadable plugin origins", () => {
  afterEach(() => {
    manifestMocks.listPluginOriginsFromMetadataSnapshot.mockClear();
    manifestMocks.loadPluginMetadataSnapshot.mockReset();
    manifestMocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("skips metadata snapshot loading when plugin entries are absent", async () => {
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            openai: {
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
            },
          },
        },
      }),
      env: { OPENAI_API_KEY: "sk-test" },
      includeAuthStoreRefs: false,
    });

    expect(manifestMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("derives loadable plugin origins from the shared metadata snapshot", async () => {
    const snapshot = {
      plugins: [{ id: "demo", origin: "workspace" }],
    };
    manifestMocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        plugins: {
          entries: {
            demo: {
              config: {
                apiKey: { source: "env", provider: "default", id: "DEMO_API_KEY" },
              },
            },
          },
        },
      }),
      env: { HOME: "/home/demo", DEMO_API_KEY: "sk-demo" },
      includeAuthStoreRefs: false,
    });

    const snapshotCalls = manifestMocks.loadPluginMetadataSnapshot.mock.calls as unknown as Array<
      [
        {
          config: {
            plugins?: unknown;
          };
          workspaceDir: unknown;
          env: Record<string, unknown>;
        },
      ]
    >;
    const snapshotParams = snapshotCalls[0]?.[0];
    expect(snapshotParams?.config.plugins).toStrictEqual({
      entries: {
        demo: {
          config: {
            apiKey: { source: "env", provider: "default", id: "DEMO_API_KEY" },
          },
        },
      },
    });
    expect(typeof snapshotParams?.workspaceDir).toBe("string");
    expect(snapshotParams?.env.HOME).toBe("/home/demo");
    expect(snapshotParams?.env.DEMO_API_KEY).toBe("sk-demo");
    expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it("carries the shared manifest registry into plugin-managed SecretRef resolution", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-runtime-secret-provider-"));
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
    const plugin: PluginManifestRecord = {
      id: "vault-secrets",
      rootDir,
      source: path.join(rootDir, "index.ts"),
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
      origin: "global",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    };
    const pluginMetadataSnapshot = {
      plugins: [plugin],
      manifestRegistry: {
        plugins: [plugin],
        diagnostics: [],
      },
    };

    try {
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          gateway: {
            auth: {
              mode: "token",
              token: { source: "exec", provider: "vault", id: "gateway/token" },
            },
          },
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
        }),
        env: { HOME: rootDir },
        includeAuthStoreRefs: false,
        pluginMetadataSnapshot,
      });

      expect(snapshot.config.gateway?.auth?.token).toBe("value:gateway/token");
      expect(manifestMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
      expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).toHaveBeenCalledWith(
        pluginMetadataSnapshot,
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
