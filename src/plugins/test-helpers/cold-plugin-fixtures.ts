import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type ColdPluginFixture = {
  authChoiceId: string;
  channelId: string;
  pluginId: string;
  providerId: string;
  rootDir: string;
  runtimeMarker: string;
  runtimeSource: string;
};

type ColdPluginFixtureOptions = {
  rootDir: string;
  pluginId?: string;
  packageName?: string;
  packageVersion?: string;
  providerId?: string;
  channelId?: string;
  authChoiceId?: string;
  runtimeMessage?: string;
  manifest?: Record<string, unknown>;
};

export function createColdPluginFixture(options: ColdPluginFixtureOptions): ColdPluginFixture {
  const pluginId = options.pluginId ?? "cold-control-plane";
  const providerId = options.providerId ?? "cold-model-provider";
  const channelId = options.channelId ?? "cold-channel";
  const authChoiceId = options.authChoiceId ?? "cold-provider-api-key";
  const runtimeSource = path.join(options.rootDir, "index.cjs");
  const runtimeMarker = path.join(options.rootDir, "runtime-loaded.txt");
  fs.writeFileSync(
    path.join(options.rootDir, "package.json"),
    JSON.stringify(
      {
        name: options.packageName ?? "@example/openclaw-cold-control-plane",
        version: options.packageVersion ?? "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(options.rootDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: "Cold Control Plane",
        configSchema: { type: "object" },
        providers: [providerId],
        channels: [channelId],
        channelConfigs: {
          [channelId]: {
            schema: { type: "object" },
          },
        },
        providerAuthChoices: [
          {
            provider: providerId,
            method: "api-key",
            choiceId: authChoiceId,
            choiceLabel: "Cold Provider API key",
            groupId: providerId,
            groupLabel: "Cold Provider",
            optionKey: "coldProviderApiKey",
            cliFlag: "--cold-provider-api-key",
            cliOption: "--cold-provider-api-key <key>",
            onboardingScopes: ["text-inference"],
          },
        ],
        ...options.manifest,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    runtimeSource,
    `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded", "utf8");\nthrow new Error(${JSON.stringify(options.runtimeMessage ?? "runtime entry should not load for cold plugin metadata discovery")});\n`,
    "utf8",
  );
  return {
    authChoiceId,
    channelId,
    pluginId,
    providerId,
    rootDir: options.rootDir,
    runtimeMarker,
    runtimeSource,
  };
}

export function createColdPluginConfig(pluginDir: string, pluginId: string): OpenClawConfig {
  return {
    plugins: {
      load: { paths: [pluginDir] },
      entries: {
        [pluginId]: { enabled: true },
      },
    },
  };
}

export function createColdPluginHermeticEnv(
  homeDir: string,
  options: { bundledPluginsDir?: string; disablePersistedRegistry?: boolean } = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_HOME: path.join(homeDir, "home"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: options.bundledPluginsDir,
    OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY:
      options.disablePersistedRegistry === false ? undefined : "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
  };
}

export function isColdPluginRuntimeLoaded(fixture: Pick<ColdPluginFixture, "runtimeMarker">) {
  return fs.existsSync(fixture.runtimeMarker);
}
