/** Gateway startup coverage for active and inactive web-provider SecretRefs. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

const { webSearchProviders } = vi.hoisted(() => {
  const credentialPath = "plugins.entries.google.config.webSearch.apiKey";
  return {
    webSearchProviders: [
      {
        pluginId: "google",
        id: "gemini",
        label: "Gemini",
        hint: "Gateway startup test provider",
        envVars: ["GEMINI_API_KEY"],
        placeholder: "gemini-...",
        signupUrl: "https://example.com/gemini",
        autoDetectOrder: 20,
        credentialPath,
        inactiveSecretPaths: [credentialPath],
        getCredentialValue: (config: { apiKey?: unknown } | undefined) => config?.apiKey,
        setCredentialValue: (config: { apiKey?: unknown }, value: unknown) => {
          config.apiKey = value;
        },
        getConfiguredCredentialValue: (config: OpenClawConfig | undefined) => {
          const pluginConfig = config?.plugins?.entries?.google?.config;
          return pluginConfig && typeof pluginConfig === "object"
            ? (pluginConfig as { webSearch?: { apiKey?: unknown } }).webSearch?.apiKey
            : undefined;
        },
        setConfiguredCredentialValue: () => {},
        createTool: () => null,
      },
    ],
  };
});

vi.mock("./operator-approval-store.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-approval-store.js")>(
    "./operator-approval-store.js",
  );
  return {
    ...actual,
    closeOrphanedOperatorApprovals: vi.fn(() => 0),
    pruneTerminalOperatorApprovals: vi.fn(() => 0),
  };
});

vi.mock("../secrets/runtime-web-tools-manifest.runtime.js", () => ({
  resolveManifestContractPluginIds: ({ contract }: { contract: string }) =>
    contract === "webSearchProviders" ? ["google"] : [],
  resolveManifestContractOwnerPluginId: ({ value }: { value: string }) =>
    value === "gemini" ? "google" : undefined,
  resolveManifestContractPluginIdsByCompatibilityRuntimePath: () => [],
}));

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../secrets/runtime-web-tools-public-artifacts.runtime.js", () => ({
  resolveBundledWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../secrets/runtime-web-tools-fallback.runtime.js", () => ({
  runtimeWebToolsFallbackProviders: {
    resolvePluginWebSearchProviders: () => webSearchProviders,
    resolvePluginWebFetchProviders: () => [],
  },
}));

const INACTIVE_SECRET_ENV = "OPENCLAW_TEST_INACTIVE_WEB_SEARCH_SECRET";
const ACTIVE_SECRET_ENV = "OPENCLAW_TEST_ACTIVE_WEB_SEARCH_SECRET";
const SECRET_PATH = "plugins.entries.google.config.webSearch.apiKey";

installGatewayTestHooks({ scope: "suite" });

function buildConfig(params: { enabled: boolean; envVar: string }): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    tools: {
      web: {
        search: {
          enabled: params.enabled,
          provider: "gemini",
        },
      },
    },
    plugins: {
      enabled: true,
      entries: {
        google: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: {
                source: "env",
                provider: "default",
                id: params.envVar,
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile(config);
}

describe("gateway startup web-provider SecretRefs", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("starts and warns when an unresolved web secret is provably inactive", async () => {
    await withEnvAsync({ [INACTIVE_SECRET_ENV]: undefined }, async () => {
      await writeConfig(buildConfig({ enabled: false, envVar: INACTIVE_SECRET_ENV }));

      server = await startGatewayServer(await getFreePort(), { auth: { mode: "none" } });

      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toContainEqual(
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: SECRET_PATH,
        }),
      );
    });
  });

  it("fails closed when the unresolved web secret is active", async () => {
    await withEnvAsync({ [ACTIVE_SECRET_ENV]: undefined }, async () => {
      await writeConfig(buildConfig({ enabled: true, envVar: ACTIVE_SECRET_ENV }));

      await expect(
        startGatewayServer(await getFreePort(), { auth: { mode: "none" } }),
      ).rejects.toThrow(/Startup failed: required secrets are unavailable/);
    });
  });
});
