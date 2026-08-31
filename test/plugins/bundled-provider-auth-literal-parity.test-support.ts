// Keeps manifest providerAuthChoices literals aligned with registered provider.auth methods.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { listBundledPluginMetadata } from "../../src/plugins/bundled-plugin-metadata.js";
import type { PluginManifest } from "../../src/plugins/manifest.js";
import type {
  ProviderAuthMethod,
  ProviderPlugin,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../src/plugins/types.js";
import { createNonExitingRuntime } from "../../src/runtime.js";
import { createCapturedPluginRegistration } from "../../src/test-utils/plugin-registration.js";

const PARITY_TIMEOUT_MS = 120_000;
const PARITY_SHARD_COUNT = 3;
const SENTINEL_API_KEY = "parity-sentinel-api-key";
// These entries pass their manifest directly to defineSingleProviderPluginEntry,
// so provider-entry and provider-api-key-auth owner tests already prove the
// same literal projection. Runtime probes remain for custom/explicit auth.
const MANIFEST_DERIVED_PLUGIN_IDS = new Set([
  "baseten",
  "byteplus",
  "cerebras",
  "clawrouter",
  "cohere",
  "deepseek",
  "featherless",
  "fireworks",
  "gmi",
  "groq",
  "huggingface",
  "kilocode",
  "kimi",
  "longcat",
  "meta",
  "mistral",
  "novita",
  "nvidia",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "synthetic",
  "together",
  "venice",
  "vercel-ai-gateway",
  "volcengine",
]);
// GitHub Copilot's owner test derives these literals from its manifest and
// exercises the full token setup result in the already-loaded plugin suite.
const OWNER_TESTED_PLUGIN_IDS = new Set(["github-copilot"]);

type ApiKeyStyleChoice = PluginManifestProviderAuthChoice & {
  optionKey: string;
  cliFlag: string;
};

type PluginManifestProviderAuthChoice = NonNullable<PluginManifest["providerAuthChoices"]>[number];

type ParityCase = {
  pluginId: string;
  providerId: string;
  methodId: string;
  optionKey: string;
  cliFlag: string;
  setupEnvVars: readonly string[];
};

type PluginRegister = (api: ReturnType<typeof createCapturedPluginRegistration>["api"]) => void;
type CapturedPluginRegistration = ReturnType<typeof createCapturedPluginRegistration>;

type PluginEntryModule = {
  default?: {
    id?: string;
    register?: PluginRegister;
  };
  register?: PluginRegister;
};

function isApiKeyStyleChoice(
  choice: PluginManifestProviderAuthChoice,
): choice is ApiKeyStyleChoice {
  return Boolean(choice.optionKey?.trim() && choice.cliFlag?.trim());
}

function listParityCases(): ParityCase[] {
  return listBundledPluginMetadata({ includeChannelConfigs: false }).flatMap((plugin) => {
    const choices = plugin.manifest.providerAuthChoices ?? [];
    if (choices.length === 0) {
      return [];
    }
    const setupEnvByProvider = new Map(
      (plugin.manifest.setup?.providers ?? []).map((entry) => [
        entry.id,
        entry.envVars ?? ([] as readonly string[]),
      ]),
    );
    return choices.filter(isApiKeyStyleChoice).map((choice) => ({
      pluginId: plugin.manifest.id,
      providerId: choice.provider,
      methodId: choice.method,
      optionKey: choice.optionKey,
      cliFlag: choice.cliFlag,
      setupEnvVars: setupEnvByProvider.get(choice.provider) ?? [],
    }));
  });
}

async function loadPluginRegister(pluginId: string): Promise<PluginRegister> {
  // Dynamic import keeps this file out of the unit-fast lane: loading built
  // plugin dists pulls large module graphs into the shared worker cache and
  // breaks co-resident vi.mock-based unit tests (observed with memory-host-sdk).
  const { loadBundledPluginFacade, resolveBundledPluginPublicModulePath } =
    await import("../../src/test-utils/bundled-plugin-public-surface.js");
  // Resolve first so unknown plugin ids fail with a clear path error before import.
  resolveBundledPluginPublicModulePath({
    pluginId,
    artifactBasename: "index.js",
  });
  const mod = await loadBundledPluginFacade<PluginEntryModule>({
    pluginId,
    artifactBasename: "index.js",
  });
  const register = mod.default?.register ?? mod.register;
  if (!register) {
    throw new Error(`bundled plugin ${pluginId} has no register() entry`);
  }
  return register;
}

function findRegisteredProvider(
  providers: readonly ProviderPlugin[],
  providerId: string,
): ProviderPlugin | undefined {
  return providers.find(
    (provider) => provider.id === providerId || provider.hookAliases?.includes(providerId) === true,
  );
}

async function probeRuntimeAuthLiterals(params: {
  method: ProviderAuthMethod;
  optionKey: string;
  agentDir: string;
}): Promise<ProviderResolveNonInteractiveApiKeyParams | undefined> {
  if (!params.method.runNonInteractive) {
    return undefined;
  }
  // The sentinel maps only to the expected optionKey so flagValue === sentinel
  // proves the method read the right key. Other keys get distinct placeholders
  // to satisfy provider-specific preflight opts (e.g. account/gateway ids)
  // without weakening that proof.
  const opts = new Proxy<Record<string, unknown>>(
    { [params.optionKey]: SENTINEL_API_KEY },
    {
      get: (target, key) =>
        typeof key === "string" ? (target[key] ?? `parity-extra-${key}`) : undefined,
    },
  );
  let captured: ProviderResolveNonInteractiveApiKeyParams | undefined;
  try {
    await params.method.runNonInteractive({
      authChoice: "parity",
      agentDir: params.agentDir,
      config: {},
      baseConfig: {},
      opts,
      runtime: createNonExitingRuntime(),
      resolveApiKey: async (resolveParams) => {
        if (!captured) {
          captured = resolveParams;
        }
        return null;
      },
      toApiKeyCredential: () => null,
    });
  } catch {
    // Some methods throw when credentials are incomplete; captured params still count.
  }
  return captured;
}

const allParityCases = listParityCases().toSorted((left, right) => {
  const pluginOrder = left.pluginId.localeCompare(right.pluginId);
  if (pluginOrder !== 0) {
    return pluginOrder;
  }
  const providerOrder = left.providerId.localeCompare(right.providerId);
  if (providerOrder !== 0) {
    return providerOrder;
  }
  return left.methodId.localeCompare(right.methodId);
});

const allParityPluginIds = [...new Set(allParityCases.map((entry) => entry.pluginId))];
export function defineBundledProviderAuthLiteralParityTests(shardIndex: number): void {
  const parityPluginIds = allParityPluginIds.filter(
    (pluginId, index) =>
      index % PARITY_SHARD_COUNT === shardIndex &&
      !MANIFEST_DERIVED_PLUGIN_IDS.has(pluginId) &&
      !OWNER_TESTED_PLUGIN_IDS.has(pluginId),
  );
  const parityPluginIdSet = new Set(parityPluginIds);
  const parityCases = allParityCases.filter((entry) => parityPluginIdSet.has(entry.pluginId));
  const probeAgentDir = mkdtempSync(path.join(tmpdir(), "openclaw-auth-parity-"));
  const registrationResultByPluginId = new Map<
    string,
    PromiseSettledResult<CapturedPluginRegistration>
  >();

  beforeAll(async () => {
    // Full plugin entry graphs contend heavily when transformed concurrently.
    for (const pluginId of parityPluginIds) {
      try {
        const register = await loadPluginRegister(pluginId);
        const captured = createCapturedPluginRegistration({
          id: pluginId,
          name: pluginId,
          source: `bundled:${pluginId}`,
        });
        captured.api.runtime = createPluginRuntimeMock();
        register(captured.api);
        registrationResultByPluginId.set(pluginId, { status: "fulfilled", value: captured });
      } catch (reason) {
        registrationResultByPluginId.set(pluginId, { status: "rejected", reason });
      }
    }
  });

  afterAll(() => {
    rmSync(probeAgentDir, { recursive: true, force: true });
  });

  describe(`bundled provider manifest↔runtime auth literal parity (${shardIndex + 1}/${PARITY_SHARD_COUNT})`, () => {
    it("discovers custom api-key-style provider auth choices", () => {
      expect(allParityCases.length).toBeGreaterThan(parityCases.length);
      expect(parityCases.length).toBeGreaterThan(0);
    });

    it.each(parityCases)(
      "$pluginId $providerId/$methodId optionKey=$optionKey",
      { timeout: PARITY_TIMEOUT_MS },
      async (parityCase) => {
        const registrationResult = registrationResultByPluginId.get(parityCase.pluginId);
        if (!registrationResult) {
          throw new Error(`bundled plugin ${parityCase.pluginId} was not preloaded`);
        }
        if (registrationResult.status === "rejected") {
          throw new Error(`bundled plugin ${parityCase.pluginId} preload or registration failed`, {
            cause: registrationResult.reason,
          });
        }
        const captured = registrationResult.value;

        const provider = findRegisteredProvider(captured.providers, parityCase.providerId);
        if (!provider) {
          // Capability-only plugins (video/image onboard flags) register no text
          // providers at all. A plugin that registers text providers but not the
          // manifest-declared id has drifted — the exact mismatch this test guards.
          expect(
            captured.providers.map((entry) => entry.id),
            `${parityCase.pluginId} manifest declares provider ${parityCase.providerId} but runtime registers different providers`,
          ).toEqual([]);
          return;
        }

        const method = provider.auth.find((entry) => entry.id === parityCase.methodId);
        expect(
          method,
          `${parityCase.pluginId} runtime auth missing method ${parityCase.methodId}`,
        ).toBeDefined();
        if (!method) {
          return;
        }

        // methodId (manifest `method`) ↔ runtime auth id
        expect(method.id).toBe(parityCase.methodId);

        const probed = await probeRuntimeAuthLiterals({
          method,
          optionKey: parityCase.optionKey,
          agentDir: probeAgentDir,
        });
        // Fail closed: an api-key-style choice whose method cannot be probed
        // would otherwise leave its flag/env literals unchecked while CI stays
        // green — the same silent-drift hole this test exists to close.
        expect(
          probed,
          `${parityCase.pluginId} auth method ${parityCase.methodId} did not resolve an API key non-interactively; flag/env literals unverifiable`,
        ).toBeDefined();
        if (!probed) {
          return;
        }

        // cliFlag ↔ flagName; optionKey proven when opts[optionKey] becomes flagValue
        expect(probed.flagName).toBe(parityCase.cliFlag);
        expect(probed.flagValue).toBe(SENTINEL_API_KEY);

        // envVar ↔ setup.providers[].envVars and/or provider.envVars
        const knownEnvVars = new Set([...parityCase.setupEnvVars, ...(provider.envVars ?? [])]);
        if (knownEnvVars.size > 0) {
          expect(knownEnvVars.has(probed.envVar)).toBe(true);
        }
      },
    );
  });
}
