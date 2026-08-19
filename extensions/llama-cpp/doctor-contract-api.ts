import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  LLAMA_CPP_DEFAULT_PORT,
  LLAMA_CPP_PROVIDER_ID,
  buildLlamaCppProviderConfig,
} from "./src/defaults.js";
import {
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
} from "./src/llama-server-assets.js";

const LEGACY_BASE_URL = "local://llama-cpp";
const PROVIDER_PATH = "models.providers.llama-cpp";

export const legacyConfigRules = [
  {
    path: ["models", "providers", LLAMA_CPP_PROVIDER_ID, "baseUrl"],
    message: `${PROVIDER_PATH}.baseUrl uses the retired in-process runtime. Run "openclaw doctor --fix", then rerun interactive llama.cpp setup.`,
    match: (value: unknown) => value === LEGACY_BASE_URL,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const provider = cfg.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (provider?.baseUrl !== LEGACY_BASE_URL) {
    return { config: cfg, changes: [] };
  }
  const { command, presetPath } = resolveManagedLlamaServerPaths(selectLlamaServerAsset());
  const rootUrl = `http://127.0.0.1:${LLAMA_CPP_DEFAULT_PORT}`;
  const managed = {
    command,
    baseUrl: `${rootUrl}/v1`,
    healthUrl: `${rootUrl}/health`,
    args: [
      "--host",
      "127.0.0.1",
      "--port",
      String(LLAMA_CPP_DEFAULT_PORT),
      "--models-preset",
      presetPath,
      "--models-max",
      "2",
      "--metrics",
      "--no-ui",
    ],
  };
  return {
    config: {
      ...cfg,
      models: {
        ...cfg.models,
        providers: {
          ...cfg.models?.providers,
          [LLAMA_CPP_PROVIDER_ID]: buildLlamaCppProviderConfig(provider, managed),
        },
      },
    },
    changes: [
      `${PROVIDER_PATH}: migrated from the retired in-process runtime to managed llama-server; rerun interactive llama.cpp setup to verify/install runtime artifacts`,
    ],
  };
}
