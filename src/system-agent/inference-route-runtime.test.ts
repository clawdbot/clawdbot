import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "../agents/model-auth-runtime-config.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { looksLikeSecretSentinel } from "../secrets/sentinel.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import { completeSetupInference, verifySetupInference } from "./setup-inference-verify.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  resolveSystemAgentVerifiedInferenceRoute,
} from "./verified-inference.js";

const key = "synthetic-setup-test-key";
const secretRef = { source: "store", provider: "default", id: "SETUP_TEST_KEY" } as const;
const readSnapshot = () =>
  readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
let temp: TempHomeEnv;
let configPath: string;

async function readRuntime() {
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  return snapshot.runtimeConfig ?? snapshot.config;
}

async function activate() {
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  activateSecretsRuntimeSnapshotWithSource(
    await prepareSecretsRuntimeSnapshot({
      config: snapshot.runtimeConfig,
      env: process.env,
      includeAuthStoreRefs: false,
      manifestRegistry: { plugins: [] },
      loadablePluginOrigins: new Map(),
    }),
    snapshot.sourceConfig,
  );
}

function storeKey(value: string) {
  writeSecretStoreEntry({
    scope: { kind: "team" },
    name: secretRef.id,
    value,
    kind: "secret",
    allowedHosts: ["provider.example"],
    updatedBy: "test",
  });
}

beforeEach(async () => {
  temp = await createTempHomeEnv("openclaw-setup-runtime-");
  configPath = path.join(temp.home, ".openclaw", "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "1");
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      defaults: { model: "fixture/test-model" },
      entries: { main: { workspace: path.join(temp.home, "workspace") } },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-responses",
          baseUrl: "https://provider.example/v1",
          apiKey: secretRef,
          models: [
            {
              id: "test-model",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 1000,
            },
          ],
        },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  storeKey(key);
  await activate();
});

afterEach(async () => {
  clearSecretsRuntimeSnapshot();
  vi.unstubAllEnvs();
  await temp?.restore();
});

it("keeps protected credentials through a fresh setup read and verified-route revalidation", async () => {
  const snapshot = await readSnapshot();
  const source = snapshot.runtimeConfig;
  expect(source).not.toEqual(snapshot.sourceConfig);
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    source,
    "main",
    { pluginMetadataPlugins: [] },
    snapshot,
  );
  expect(route).not.toBeNull();
  expect(route!.runConfig.agents?.entries).toHaveProperty("openclaw");
  expect(snapshot.sourceConfig.agents?.defaults?.maxConcurrent).toBeUndefined();
  expect(route!.runConfig.agents?.defaults?.maxConcurrent).toBeGreaterThan(0);
  expect(
    resolveManagedSecretRefRuntimeProviderAuth({ cfg: route!.runConfig, provider: "fixture" })
      ?.apiKey,
  ).toBe(key);
  const auth = await resolveApiKeyForProviderCore({
    cfg: route!.runConfig,
    provider: "fixture",
    modelId: "test-model",
    modelApi: "openai-responses",
    agentDir: route!.agentDir,
    store: { version: 1, profiles: {} },
    allowAuthProfileFallback: false,
    secretSentinels: true,
  });
  const binding = await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route!,
    executionRoute: route!,
    auth: {
      agentHarnessId: "openclaw",
      modelId: "test-model",
      modelApi: "openai-responses",
      authFingerprint: fingerprintResolvedProviderAuth(auth),
    },
    deps: { pluginMetadataPlugins: [] },
  });
  const deps = { readConfigFileSnapshot: readSnapshot, pluginMetadataPlugins: [] };
  expect(await resolveSystemAgentVerifiedInferenceRoute(binding, deps)).not.toBeNull();
  // Neither the persisted input nor the configured-route fingerprint may contain the key.
  expect(source.models?.providers?.fixture?.apiKey).toEqual(secretRef);
  expect(JSON.stringify(binding.executionFingerprint)).not.toContain(key);
  expect(await fs.readFile(configPath, "utf8")).not.toContain(key);

  storeKey("synthetic-rotated-key");
  await activate();
  expect(await resolveSystemAgentVerifiedInferenceRoute(binding, deps)).toBeNull();
});

it.each([
  {
    label: "protected key",
    entrypoint: "verify",
    rotateBeforeBinding: false,
    alternateProfile: false,
  },
  {
    label: "key rotated during probe",
    entrypoint: "verify",
    rotateBeforeBinding: true,
    alternateProfile: false,
  },
  {
    label: "alternate profile available",
    entrypoint: "verify",
    rotateBeforeBinding: false,
    alternateProfile: true,
  },
  {
    label: "completion",
    entrypoint: "complete",
    rotateBeforeBinding: false,
    alternateProfile: false,
  },
  {
    label: "existing-model activation",
    entrypoint: "activate",
    rotateBeforeBinding: false,
    alternateProfile: false,
  },
  {
    label: "non-default fallback owner",
    entrypoint: "fallback",
    rotateBeforeBinding: false,
    alternateProfile: false,
  },
])(
  "verifies the actual setup entrypoint: $label",
  async ({ entrypoint, rotateBeforeBinding, alternateProfile }) => {
    if (entrypoint === "fallback") {
      const config = (await readSnapshot()).sourceConfig;
      config.agents!.ownership = "explicit";
      config.agents!.defaults!.systemAgent = { agentId: "main" };
      config.agents!.entries!.engineering = {
        model: "fixture/test-model",
        params: { temperature: 0.1 },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await activate();
      expect((await readRuntime()).agents?.entries).toHaveProperty("engineering");
    }
    if (alternateProfile) {
      upsertAuthProfile({
        agentDir: resolveAgentDir(await readRuntime(), "main"),
        profileId: "fixture:alternate",
        credential: { type: "api_key", provider: "fixture", key: "synthetic-alternate-key" },
      });
    }
    const runEmbeddedAgent = vi.fn<
      NonNullable<
        NonNullable<Parameters<typeof verifySetupInference>[0]["deps"]>["runEmbeddedAgent"]
      >
    >(async (params) => {
      // Replace only the model turn; use the real planner and credential resolver.
      const store = ensureAuthProfileStore(params.agentDir);
      const prepared = prepareAgentRuntimeAuth({
        config: params.config,
        provider: "fixture",
        modelId: "test-model",
        modelApi: "openai-responses",
        modelBaseUrl: "https://provider.example/v1",
        agentDir: params.agentDir,
        env: {},
        metadataSnapshot: resolvePluginMetadataSnapshot({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
        }),
        authProfileStore: store,
      });
      const attempt = prepared.attempts[0];
      if (attempt?.kind !== "direct") {
        throw new Error("Expected the configured direct provider credential");
      }
      expect(attempt.allowAuthProfileFallback).toBe(false);
      const auth = await resolveApiKeyForProviderCore({
        cfg: params.config,
        provider: "fixture",
        modelId: "test-model",
        modelApi: "openai-responses",
        agentDir: params.agentDir,
        store,
        allowAuthProfileFallback: attempt.allowAuthProfileFallback,
        secretSentinels: true,
      });
      expect(looksLikeSecretSentinel(auth.apiKey ?? "")).toBe(true);
      params.onSuccessfulAuthBinding?.({
        agentHarnessId: "openclaw",
        modelId: "test-model",
        modelApi: "openai-responses",
        authFingerprint: fingerprintResolvedProviderAuth(auth),
      });
      if (rotateBeforeBinding) {
        storeKey("synthetic-rotated-key");
        await activate();
      }
      return {
        meta: {
          durationMs: 1,
          finalAssistantVisibleText: "OK",
          executionTrace: { winnerProvider: "fixture", winnerModel: "test-model" },
        },
      };
    });
    const runtime = {
      log() {},
      error() {},
      exit() {
        throw new Error("Unexpected exit");
      },
    };
    const deps = {
      readConfigFileSnapshot: readSnapshot,
      createTempDir: () => fs.mkdtemp(path.join(temp.home, "probe-")),
      runEmbeddedAgent,
    };
    const attemptedOwners: string[] = [];
    const result =
      entrypoint === "complete"
        ? await completeSetupInference({ prompt: "Reply with OK", runtime, deps })
        : entrypoint === "activate"
          ? await activateSetupInference({
              kind: "existing-model",
              surface: "gateway",
              runtime,
              deps,
            })
          : entrypoint === "fallback"
            ? await verifySystemAgentInferenceWithFallback({
                runtime,
                deps: {
                  verify: async (params) => {
                    attemptedOwners.push(params.agentId);
                    return params.agentId === "main"
                      ? { ok: false, status: "auth", error: "Primary owner unavailable" }
                      : verifySetupInference({ ...params, deps });
                  },
                },
              })
            : await verifySetupInference({ agentId: "main", bindSession: true, runtime, deps });
    expect(result.ok, result.ok ? undefined : result.error).toBe(!rotateBeforeBinding);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    if (result.ok && "binding" in result) {
      expect(
        await resolveSystemAgentVerifiedInferenceRoute(result.binding, {
          readConfigFileSnapshot: readSnapshot,
          pluginMetadataPlugins: [],
        }),
      ).not.toBeNull();
      if (entrypoint === "fallback") {
        expect(attemptedOwners).toEqual(["main", "engineering"]);
        expect(result.binding.execution.agentId).toBe("engineering");
        expect(result.binding.execution.runConfig.agents?.entries?.openclaw?.params).toEqual({
          temperature: 0.1,
        });
      }
    } else if (!result.ok) {
      expect(result.error).toContain("owner changed");
    }
    expect((await readRuntime()).models?.providers?.fixture?.apiKey).toEqual(secretRef);
  },
);

it.each([
  { field: "destination", saved: false },
  { field: "destination", saved: true },
  { field: "reference", saved: false },
  { field: "reference", saved: true },
])(
  "does not lend the active key after changing $field (saved: $saved)",
  async ({ field, saved }) => {
    let snapshot = await readSnapshot();
    let candidate = cloneConfigWithResolutionFacts(snapshot.runtimeConfig);
    const provider = candidate.models?.providers?.fixture;
    if (!provider) {
      throw new Error("Missing fixture provider");
    }
    const expectedRef = field === "reference" ? { ...secretRef, id: "OTHER_KEY" } : secretRef;
    provider.apiKey = expectedRef;
    if (field === "destination") {
      provider.baseUrl = "https://other.example/v1";
    }
    if (saved) {
      await fs.writeFile(configPath, JSON.stringify(candidate));
      snapshot = await readSnapshot();
      candidate = snapshot.runtimeConfig;
    }
    // A changed candidate with the old read, or a fresh read whose new source is
    // not active yet: neither may reuse credentials prepared for the old owner.
    const route = await resolveSystemAgentConfiguredRouteFromConfig(
      candidate,
      "main",
      { pluginMetadataPlugins: [] },
      snapshot,
    );
    expect(route).not.toBeNull();
    expect(
      resolveManagedSecretRefRuntimeProviderAuth({ cfg: route!.runConfig, provider: "fixture" }),
    ).toBeUndefined();
    expect(route!.runConfig.models?.providers?.fixture?.apiKey).toEqual(expectedRef);
  },
);

it("retains the materialized view when no prepared runtime is active", async () => {
  clearSecretsRuntimeSnapshot();
  const snapshot = await readSnapshot();
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    snapshot.runtimeConfig,
    "main",
    { pluginMetadataPlugins: [] },
    snapshot,
  );
  expect(route).not.toBeNull();
  expect(route!.runConfig.agents?.defaults?.maxConcurrent).toBeGreaterThan(0);
  expect(route!.runConfig.models?.providers?.fixture?.apiKey).toEqual(secretRef);
  expect(
    resolveManagedSecretRefRuntimeProviderAuth({ cfg: route!.runConfig, provider: "fixture" }),
  ).toBeUndefined();
});
