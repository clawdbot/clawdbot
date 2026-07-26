// Keeps manifest providerAuthChoices literals aligned with registered provider.auth methods.
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const SENTINEL_API_KEY = "parity-sentinel-api-key";

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
  const { loadBundledPluginPublicSurface, resolveBundledPluginPublicModulePath } =
    await import("../../src/test-utils/bundled-plugin-public-surface.js");
  // Resolve first so unknown plugin ids fail with a clear path error before import.
  resolveBundledPluginPublicModulePath({
    pluginId,
    artifactBasename: "index.js",
  });
  const mod = await loadBundledPluginPublicSurface<PluginEntryModule>({
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

const parityCases = listParityCases().toSorted((left, right) => {
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

const probeAgentDir = mkdtempSync(path.join(tmpdir(), "openclaw-auth-parity-"));
// Keep at least five imports in flight, but leave CPU headroom on larger CI runners.
const PLUGIN_LOAD_CONCURRENCY = Math.max(5, Math.min(12, availableParallelism()));
const parityPluginIds = [...new Set(parityCases.map((entry) => entry.pluginId))];
const registerResultByPluginId = new Map<string, Promise<PromiseSettledResult<PluginRegister>>>();

beforeAll(() => {
  // Bound only module loading. Auth probes stay serial because provider setup
  // can log or inspect the shared probe directory.
  const limitPluginLoad = pLimit(PLUGIN_LOAD_CONCURRENCY);
  for (const pluginId of parityPluginIds) {
    // Settle each preload independently so one hung or rejected plugin cannot
    // suppress parity coverage for plugins that loaded successfully.
    registerResultByPluginId.set(
      pluginId,
      limitPluginLoad(() => loadPluginRegister(pluginId)).then(
        (value): PromiseFulfilledResult<PluginRegister> => ({ status: "fulfilled", value }),
        (reason): PromiseRejectedResult => ({ status: "rejected", reason }),
      ),
    );
  }
});

afterAll(() => {
  rmSync(probeAgentDir, { recursive: true, force: true });
});

describe("bundled provider manifest↔runtime auth literal parity", () => {
  it("discovers api-key-style providerAuthChoices from bundled plugins", () => {
    expect(parityCases.length).toBeGreaterThan(0);
    expect(new Set(parityCases.map((entry) => entry.pluginId)).size).toBeGreaterThan(10);
  });

  it.each(parityCases)(
    "$pluginId $providerId/$methodId optionKey=$optionKey",
    { timeout: PARITY_TIMEOUT_MS },
    async (parityCase) => {
      const registerResultPromise = registerResultByPluginId.get(parityCase.pluginId);
      if (!registerResultPromise) {
        throw new Error(`bundled plugin ${parityCase.pluginId} was not preloaded`);
      }
      const registerResult = await registerResultPromise;
      if (registerResult.status === "rejected") {
        throw new Error(`bundled plugin ${parityCase.pluginId} preload failed`, {
          cause: registerResult.reason,
        });
      }
      const register = registerResult.value;
      const captured = createCapturedPluginRegistration({
        id: parityCase.pluginId,
        name: parityCase.pluginId,
        source: `bundled:${parityCase.pluginId}`,
      });
      register(captured.api);

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
