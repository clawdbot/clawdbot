import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintAuthProfileCredential,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/types.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { resolvePersistentApplyInference } from "./setup-inference.js";
import {
  installSystemAgentClaudeCliBackendTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

const pluginRegistryState = vi.hoisted(() => ({
  providerOwnerIds: ["provider-owner"],
  records: [] as Array<Record<string, unknown>>,
}));
const harnessRuntimeArtifactState = vi.hoisted(() => ({
  id: "codex-app-server",
  fingerprint: "codex-runtime-v1",
  valid: true,
  ownsAuthBootstrap: true,
}));

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => [...pluginRegistryState.providerOwnerIds]),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => [...pluginRegistryState.providerOwnerIds]),
}));

vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

vi.mock("../agents/harness/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/registry.js")>()),
  getRegisteredAgentHarness: vi.fn((id: string) =>
    id === "codex"
      ? {
          harness: {
            ...(harnessRuntimeArtifactState.ownsAuthBootstrap
              ? { authBootstrap: "harness" as const }
              : {}),
            runtimeArtifact: {
              validate: async (artifact: { id: string; fingerprint: string }) =>
                harnessRuntimeArtifactState.valid &&
                artifact.id === harnessRuntimeArtifactState.id &&
                artifact.fingerprint === harnessRuntimeArtifactState.fingerprint,
            },
          },
        }
      : undefined,
  ),
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: pluginRegistryState.records }) as never),
}));

const profile = {
  type: "api_key" as const,
  provider: "openai",
  key: "verified-key",
};

const runtime = { log: () => {}, error: () => {}, exit: () => {} } as never;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;
let restoreCliBackendFixture: (() => void) | undefined;

beforeAll(() => {
  pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot(config());
  restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
});

afterAll(() => {
  restoreCliBackendFixture?.();
  pluginMetadataSnapshot?.restore();
});

type TestPluginRecord = {
  pluginId: string;
  origin: PluginOrigin;
  rootDir: string;
  manifestPath: string;
  manifestHash: string;
  source: string;
  packageName: string;
  packageVersion: string;
  installRecordHash?: string;
  packageJson: { path: string; hash: string };
};

function pluginRecord(
  pluginId: string,
  overrides: Partial<TestPluginRecord> = {},
): TestPluginRecord {
  const rootDir = `/plugins/${pluginId}`;
  return {
    pluginId,
    origin: "global",
    rootDir,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    manifestHash: `${pluginId}-manifest-v1`,
    source: `${rootDir}/index.js`,
    packageName: `@openclaw/${pluginId}`,
    packageVersion: "1.0.0",
    installRecordHash: `${pluginId}-install-v1`,
    packageJson: { path: `${rootDir}/package.json`, hash: `${pluginId}-package-v1` },
    ...overrides,
  };
}

beforeEach(() => {
  pluginMetadataSnapshot?.rebindForCurrentEnv();
  pluginRegistryState.providerOwnerIds = ["provider-owner"];
  pluginRegistryState.records = [pluginRecord("provider-owner"), pluginRecord("codex")];
  harnessRuntimeArtifactState.id = "codex-app-server";
  harnessRuntimeArtifactState.fingerprint = "codex-runtime-v1";
  harnessRuntimeArtifactState.valid = true;
  harnessRuntimeArtifactState.ownsAuthBootstrap = true;
});

function authDeps(apiKey = "verified-key") {
  const resolvedAuth = profileAuth("openai:verified", apiKey);
  return {
    ensureAuthProfileStore: profileStore("openai:verified", { ...profile, key: apiKey }),
    resolveApiKeyForProvider: vi.fn(async () => resolvedAuth),
    resolveAgentHarnessAuthBindingFingerprint: vi.fn(
      async (
        params: Parameters<
          NonNullable<SystemAgentVerifiedInferenceDeps["resolveAgentHarnessAuthBindingFingerprint"]>
        >[0],
      ) => {
        const credential = params.authProfileStore.profiles[params.authProfileId];
        return credential
          ? fingerprintResolvedAuthProfileCredential({
              profileId: params.authProfileId,
              credential,
              resolvedAuth: profileAuth(params.authProfileId, apiKey),
            })
          : undefined;
      },
    ),
  };
}

function pluginArtifactDeps() {
  return {
    fingerprintPluginRuntimeArtifact: (record: { pluginId: string }) =>
      `${record.pluginId}-runtime-v1`,
  };
}

function cliRuntimeArtifactDeps(fingerprint = "claude-cli-artifact-v1") {
  return {
    resolveCliRuntimeArtifactFingerprint: vi.fn(async () => fingerprint),
  };
}

const cliRuntimeArtifactAuth = {
  runtimeArtifactFingerprint: "claude-cli-artifact-v1",
  runtimeArtifactId: "claude-cli",
} as const;

const codexRuntimeArtifactAuth = {
  runtimeArtifactFingerprint: "codex-runtime-v1",
  runtimeArtifactId: "codex-app-server",
} as const;

function config(model = "openai/gpt-5.5@openai:verified"): OpenClawConfig {
  return {
    agents: { defaults: { model } },
    auth: {
      profiles: {
        "openai:verified": { provider: "openai", mode: "api_key" },
      },
    },
  };
}

function profileAuth(profileId: string, apiKey: string) {
  return { apiKey, profileId, source: `profile:${profileId}`, mode: "api-key" as const };
}

function profileStore(profileId: string, credential: object) {
  return vi.fn(() => ({ version: 1, profiles: { [profileId]: credential } })) as never;
}

function requireFingerprint(value: string | undefined): string {
  if (!value) {
    throw new Error("missing test auth fingerprint");
  }
  return value;
}

async function bindingFor(
  baseConfig: OpenClawConfig,
  deps: SystemAgentVerifiedInferenceDeps = { ...authDeps(), ...pluginArtifactDeps() },
) {
  const route = await requireRoute(baseConfig);
  const authFingerprint = requireFingerprint(
    fingerprintAuthProfileCredential({ profileId: "openai:verified", credential: profile }),
  );
  const agentHarnessId =
    route.runner === "embedded"
      ? route.agentHarnessRuntimeOverride === "auto"
        ? "openclaw"
        : (route.agentHarnessRuntimeOverride ?? "codex")
      : undefined;
  return createBinding(
    route,
    {
      authProfileId: "openai:verified",
      authFingerprint,
      modelId: route.model,
      modelApi: route.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      ...(agentHarnessId
        ? {
            agentHarnessId,
            ...(agentHarnessId === "openclaw"
              ? {}
              : {
                  runtimeOwnerKind: "plugin-harness" as const,
                  runtimeOwnerId: agentHarnessId,
                  ...codexRuntimeArtifactAuth,
                }),
          }
        : {}),
    },
    deps,
  );
}

type ConfiguredRoute = NonNullable<
  Awaited<ReturnType<typeof resolveSystemAgentConfiguredRouteFromConfig>>
>;
type EmbeddedRoute = Extract<ConfiguredRoute, { runner: "embedded" }>;
type CliRoute = Extract<ConfiguredRoute, { runner: "cli" }>;

async function requireRoute(baseConfig: OpenClawConfig): Promise<ConfiguredRoute>;
async function requireRoute(baseConfig: OpenClawConfig, runner: "embedded"): Promise<EmbeddedRoute>;
async function requireRoute(baseConfig: OpenClawConfig, runner: "cli"): Promise<CliRoute>;
async function requireRoute(baseConfig: OpenClawConfig, runner?: ConfiguredRoute["runner"]) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(baseConfig);
  if (!route || (runner && route.runner !== runner)) {
    throw new Error("missing test route");
  }
  return route;
}

function createBinding(
  route: ConfiguredRoute,
  auth: Parameters<typeof createSystemAgentVerifiedInferenceBinding>[0]["auth"],
  deps: SystemAgentVerifiedInferenceDeps = {},
) {
  return createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth,
    deps,
  });
}

function configSnapshot(baseConfig: OpenClawConfig) {
  const snapshot = { exists: true, valid: true, config: baseConfig };
  return { readConfigFileSnapshot: vi.fn(async () => snapshot) as never };
}

function codexHarnessConfig(
  profileId?: string,
  plugins?: OpenClawConfig["plugins"],
): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "ops",
          default: true,
          model: `openai/gpt-5.5${profileId ? `@${profileId}` : ""}`,
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
        },
      ],
    },
    ...(profileId
      ? { auth: { profiles: { [profileId]: { provider: "openai", mode: "api_key" } } } }
      : {}),
    ...(plugins ? { plugins } : {}),
  };
}

function opaqueHarnessAuth(route: ConfiguredRoute, backendId = "codex") {
  const runtimeOwnerFingerprint = requireFingerprint(
    fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: route.provider,
      backendId,
      runtimeArtifactFingerprint: codexRuntimeArtifactAuth.runtimeArtifactFingerprint,
    }),
  );
  return {
    agentHarnessId: backendId,
    runtimeOwnerFingerprint,
    runtimeOwnerKind: "plugin-harness" as const,
    runtimeOwnerId: backendId,
    ...codexRuntimeArtifactAuth,
  };
}

async function opaqueHarnessBinding(
  baseConfig: OpenClawConfig,
  options: { configuredAuto?: boolean; backendId?: string } = {},
) {
  const route = await requireRoute(baseConfig, "embedded");
  const configuredRoute = options.configuredAuto
    ? ({ ...route, agentHarnessRuntimeOverride: "auto" } satisfies ConfiguredRoute)
    : route;
  const binding = await createBinding(
    configuredRoute,
    opaqueHarnessAuth(configuredRoute, options.backendId),
    pluginArtifactDeps(),
  );
  return { binding };
}

async function revalidate(
  binding: Awaited<ReturnType<typeof bindingFor>>,
  baseConfig: OpenClawConfig,
  deps: SystemAgentVerifiedInferenceDeps = {},
) {
  return resolveSystemAgentVerifiedInferenceRoute(binding, {
    ...configSnapshot(baseConfig),
    ...deps,
  });
}

async function envAuthFixture() {
  const baseConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-5.6",
        models: { "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } } },
      },
    },
  } satisfies OpenClawConfig;
  const route = await requireRoute(baseConfig);
  const resolvedAuth = {
    apiKey: "env-key",
    source: "env: OPENAI_API_KEY",
    mode: "api-key" as const,
  };
  return {
    route,
    authFingerprint: requireFingerprint(fingerprintResolvedProviderAuth(resolvedAuth)),
    resolveAuth: vi.fn(async () => resolvedAuth),
  };
}

describe("verified OpenClaw inference binding", () => {
  it("invalidates an identity-less OAuth binding when its grant changes", async () => {
    const oauthConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8@anthropic:oauth" } },
      auth: { profiles: { "anthropic:oauth": { provider: "anthropic", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    const route = await requireRoute(oauthConfig);
    const credential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "access-a",
      refresh: "refresh-a",
      expires: 1,
    };
    const authFingerprint = requireFingerprint(
      fingerprintAuthProfileCredential({ profileId: "anthropic:oauth", credential }),
    );
    const binding = await createBinding(
      route,
      {
        authProfileId: "anthropic:oauth",
        authFingerprint,
        agentHarnessId: "openclaw",
      },
      {
        ...pluginArtifactDeps(),
        ensureAuthProfileStore: profileStore("anthropic:oauth", credential),
      },
    );

    const current = await revalidate(binding, oauthConfig, {
      ensureAuthProfileStore: profileStore("anthropic:oauth", {
        ...credential,
        access: "access-b",
        refresh: "refresh-b",
      }),
    });

    expect(current).toBeNull();
  });

  it("rejects a binding when no credential fingerprint can be observed", async () => {
    const route = await requireRoute(config());

    await expect(
      createBinding(
        route,
        {
          authProfileId: "openai:verified",
          authFingerprint: "reported-owner",
          agentHarnessId: "codex",
          runtimeOwnerKind: "plugin-harness",
          runtimeOwnerId: "codex",
          ...codexRuntimeArtifactAuth,
        },
        {
          ...pluginArtifactDeps(),
          ensureAuthProfileStore: profileStore("openai:verified", {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "file", provider: "vault", id: "/openai/key" },
          }),
          resolveAgentHarnessAuthBindingFingerprint: vi.fn(async () => {
            throw new Error("active secret unavailable");
          }),
        },
      ),
    ).rejects.toThrow("active secret unavailable");
  });

  it("reuses the successful model transport facts for owner re-resolution", async () => {
    // The successful run already resolved the model under its selected auth
    // plan. Revalidation must carry that exact tuple forward instead of
    // repeating catalog and provider discovery in the authority hot path.
    const { route, authFingerprint, resolveAuth } = await envAuthFixture();
    const binding = await createBinding(
      route,
      {
        authFingerprint,
        agentHarnessId: "openclaw",
        modelId: "gpt-5.6",
        modelApi: "openai-responses",
      },
      {
        ...pluginArtifactDeps(),
        resolveApiKeyForProvider: resolveAuth as never,
      },
    );

    expect(binding.auth.authFingerprint).toBe(authFingerprint);
    expect(resolveAuth).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gpt-5.6", modelApi: "openai-responses" }),
    );
  });

  it("fails closed when a credential-backed run omits its model transport facts", async () => {
    const { route, authFingerprint, resolveAuth } = await envAuthFixture();

    await expect(
      createBinding(
        route,
        { authFingerprint, agentHarnessId: "openclaw" },
        {
          ...pluginArtifactDeps(),
          resolveApiKeyForProvider: resolveAuth as never,
        },
      ),
    ).rejects.toThrow("no longer the active route owner");
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("accepts and revalidates an opaque CLI owner emitted after a successful turn", async () => {
    const cliConfig = {
      agents: {
        entries: { ops: { default: true, model: "claude-cli/claude-opus-5" } },
      },
    } satisfies OpenClawConfig;
    const route = await requireRoute(cliConfig, "cli");
    const resolveOwner = vi.fn(async () => "opaque-cli-owner");
    const deps = {
      ...cliRuntimeArtifactDeps(),
      resolveCliRuntimeOwnerFingerprint: resolveOwner,
    };
    const binding = await createBinding(
      route,
      {
        runtimeOwnerFingerprint: "opaque-cli-owner",
        runtimeOwnerKind: "cli-runtime",
        runtimeOwnerId: "claude-cli",
        ...cliRuntimeArtifactAuth,
      },
      { ...pluginArtifactDeps(), ...deps },
    );

    expect(binding.auth).toMatchObject({
      authFingerprint: "opaque-cli-owner",
      proofKind: "runtime-owner",
    });
    expect(resolveOwner).toHaveBeenCalledWith(expect.objectContaining({ agentId: "ops" }));
    await expect(revalidate(binding, cliConfig, deps)).resolves.toBe(binding.execution);

    resolveOwner.mockResolvedValue("replacement-owner");
    await expect(revalidate(binding, cliConfig, deps)).resolves.toBeNull();
  });

  it("invalidates a strict CLI credential when its package artifact changes", async () => {
    const cliConfig = {
      agents: { defaults: { model: "claude-cli/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const route = await requireRoute(cliConfig, "cli");
    const resolveAuth = vi.fn(() => "strict-cli-credential");
    const resolveArtifact = vi.fn(async () => "claude-cli-artifact-v1");
    const binding = await createBinding(
      route,
      {
        authFingerprint: "strict-cli-credential",
        ...cliRuntimeArtifactAuth,
      },
      {
        ...pluginArtifactDeps(),
        resolveCliAuthBindingFingerprint: resolveAuth,
        resolveCliRuntimeArtifactFingerprint: resolveArtifact,
      },
    );

    resolveArtifact.mockResolvedValue("claude-cli-artifact-v2");
    await expect(
      revalidate(binding, cliConfig, {
        resolveCliAuthBindingFingerprint: resolveAuth,
        resolveCliRuntimeArtifactFingerprint: resolveArtifact,
      }),
    ).resolves.toBeNull();
  });

  it("invalidates a strict CLI binding when its forwarded SecretRef changes", async () => {
    const profileId = "claude-cli:work";
    const cliConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: `claude-cli/claude-opus-4-8@${profileId}`,
          },
        ],
      },
      auth: { profiles: { [profileId]: { provider: "claude-cli", mode: "api_key" } } },
    } satisfies OpenClawConfig;
    const credential = {
      type: "api_key" as const,
      provider: "claude-cli",
      keyRef: { source: "file" as const, provider: "vault", id: "/claude/work" },
    };
    const ensureStore = profileStore(profileId, credential);
    const route = await resolveSystemAgentConfiguredRouteFromConfig(cliConfig, undefined, {
      loadAuthProfileStoreForRuntime: ensureStore,
    });
    if (!route || route.runner !== "cli" || route.authProfileId !== profileId) {
      throw new Error("missing test CLI SecretRef route");
    }
    let activeKey = "materialized-a";
    const resolveAuth = vi.fn(async () => profileAuth(profileId, activeKey));
    const resolveBinding = vi.fn(
      (params: { resolvedAuth?: { apiKey?: string } }) =>
        params.resolvedAuth?.apiKey && `strict:${params.resolvedAuth.apiKey}`,
    );
    const binding = await createBinding(
      route,
      {
        authProfileId: profileId,
        authFingerprint: "strict:materialized-a",
        ...cliRuntimeArtifactAuth,
      },
      {
        ...pluginArtifactDeps(),
        ...cliRuntimeArtifactDeps(),
        loadAuthProfileStoreForRuntime: ensureStore,
        ensureAuthProfileStore: ensureStore,
        resolveApiKeyForProvider: resolveAuth,
        resolveCliAuthBindingFingerprint: resolveBinding as never,
      },
    );

    expect(resolveBinding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolvedAuth: expect.objectContaining({ apiKey: "materialized-a", profileId }),
      }),
    );
    expect(resolveAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId, lockedProfile: true, secretSentinels: false }),
    );
    activeKey = "materialized-b";
    await expect(
      revalidate(binding, cliConfig, {
        ...cliRuntimeArtifactDeps(),
        loadAuthProfileStoreForRuntime: ensureStore,
        ensureAuthProfileStore: ensureStore,
        resolveApiKeyForProvider: resolveAuth,
        resolveCliAuthBindingFingerprint: resolveBinding as never,
      }),
    ).resolves.toBeNull();
    expect(resolveBinding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolvedAuth: expect.objectContaining({ apiKey: "materialized-b", profileId }),
      }),
    );
    expect(resolveAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId, lockedProfile: true, secretSentinels: false }),
    );
  });

  it("revalidates a plugin-harness owner without binding rotating token material", async () => {
    const harnessConfig = codexHarnessConfig();
    const { binding } = await opaqueHarnessBinding(harnessConfig);

    expect(binding.ownerPluginIds).toEqual(["codex", "provider-owner"]);
    await expect(revalidate(binding, harnessConfig)).resolves.toBe(binding.execution);
  });

  it("invalidates a plugin-harness binding when its child runtime artifact changes", async () => {
    const harnessConfig = codexHarnessConfig();
    const { binding } = await opaqueHarnessBinding(harnessConfig);

    harnessRuntimeArtifactState.fingerprint = "codex-runtime-v2";
    await expect(revalidate(binding, harnessConfig)).resolves.toBeNull();
  });

  it("requires a child runtime artifact for credential-backed plugin harness inference", async () => {
    const harnessConfig = codexHarnessConfig("openai:verified");
    const route = await requireRoute(harnessConfig, "embedded");
    const authFingerprint = requireFingerprint(
      fingerprintAuthProfileCredential({ profileId: "openai:verified", credential: profile }),
    );
    const deps = { ...authDeps(), ...pluginArtifactDeps() };
    const harnessAuth = {
      authProfileId: "openai:verified",
      authFingerprint,
      agentHarnessId: "codex",
      runtimeOwnerKind: "plugin-harness" as const,
      runtimeOwnerId: "codex",
    };

    await expect(
      createBinding(route, { authProfileId: "openai:verified", authFingerprint }, deps),
    ).rejects.toThrow("did not report its exact runtime artifact");

    await expect(createBinding(route, harnessAuth, deps)).rejects.toThrow(
      "did not report its exact runtime artifact",
    );

    await expect(
      createBinding(route, { ...harnessAuth, ...codexRuntimeArtifactAuth }, deps),
    ).resolves.toMatchObject({
      execution: { agentHarnessRuntimeOverride: "codex" },
      auth: { authFingerprint, runtimeArtifactFingerprint: "codex-runtime-v1" },
    });
  });

  it("freezes the actual successful harness when configured policy is auto", async () => {
    const { binding } = await opaqueHarnessBinding(codexHarnessConfig(), {
      configuredAuto: true,
    });

    expect(binding.configuredRoute).toMatchObject({ agentHarnessRuntimeOverride: "auto" });
    expect(binding.execution).toMatchObject({ agentHarnessRuntimeOverride: "codex" });
    expect(binding.ownerPluginIds).toContain("codex");
  });

  it("freezes auto to the successful built-in harness", async () => {
    const harnessConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5@openai:verified",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
      auth: {
        profiles: { "openai:verified": { provider: "openai", mode: "api_key" } },
      },
    } satisfies OpenClawConfig;
    const resolved = await requireRoute(harnessConfig, "embedded");
    const configuredRoute = {
      ...resolved,
      agentHarnessRuntimeOverride: "auto",
    } satisfies typeof resolved;
    const authFingerprint = requireFingerprint(
      fingerprintResolvedProviderAuth(profileAuth("openai:verified", "verified-key")),
    );

    await expect(
      createBinding(
        configuredRoute,
        { authProfileId: "openai:verified", authFingerprint },
        authDeps(),
      ),
    ).rejects.toThrow("did not report its exact agent harness");

    const binding = await createBinding(
      configuredRoute,
      {
        authProfileId: "openai:verified",
        authFingerprint,
        agentHarnessId: "openclaw",
        modelId: configuredRoute.model,
        modelApi: "openai-responses",
      },
      { ...authDeps(), ...pluginArtifactDeps() },
    );

    expect(binding.execution).toMatchObject({ agentHarnessRuntimeOverride: "openclaw" });
    expect(binding.auth.agentHarnessId).toBe("openclaw");
  });

  it("rejects an opaque harness with no trusted manifest owner", async () => {
    const resolved = await requireRoute(codexHarnessConfig(), "embedded");
    const configuredRoute = {
      ...resolved,
      agentHarnessRuntimeOverride: "auto",
    } satisfies typeof resolved;

    await expect(
      createBinding(configuredRoute, opaqueHarnessAuth(configuredRoute, "unowned-harness"), {
        validateAgentHarnessRuntimeArtifact: vi.fn(async () => true),
      }),
    ).rejects.toThrow("no trusted manifest owner");
  });

  it("invalidates a plugin-harness owner when its manifest-owned config drifts", async () => {
    const harnessConfig = codexHarnessConfig(undefined, {
      entries: { codex: { config: { appServer: { command: "codex" } } } },
    });
    const { binding } = await opaqueHarnessBinding(harnessConfig);
    const changed = structuredClone(harnessConfig);
    changed.plugins!.entries!.codex!.config = { appServer: { command: "/opt/other/codex" } };

    await expect(revalidate(binding, changed)).resolves.toBeNull();
  });

  it("keeps core-bootstrap plugin harnesses on exact raw-profile revalidation", async () => {
    harnessRuntimeArtifactState.ownsAuthBootstrap = false;
    const harnessConfig = codexHarnessConfig("openai:verified");
    const route = await requireRoute(harnessConfig, "embedded");
    const resolvedAuth = profileAuth("openai:verified", "verified-key");
    const authFingerprint = requireFingerprint(
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:verified",
        credential: profile,
        resolvedAuth,
      }),
    );
    const resolveAuth = vi.fn(async () => resolvedAuth);
    const deps = {
      ...pluginArtifactDeps(),
      ensureAuthProfileStore: profileStore("openai:verified", profile),
      resolveApiKeyForProvider: resolveAuth,
    };
    const binding = await createBinding(
      route,
      {
        authProfileId: "openai:verified",
        authFingerprint,
        agentHarnessId: "codex",
        modelId: route.model,
        modelApi: "openai-responses",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      },
      deps,
    );

    await expect(revalidate(binding, harnessConfig, deps)).resolves.toBe(binding.execution);
    expect(resolveAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileId: "openai:verified",
        lockedProfile: true,
        secretSentinels: false,
      }),
    );
  });

  it("invalidates a plugin-harness binding when its forwarded SecretRef changes", async () => {
    const harnessConfig = codexHarnessConfig("openai:work");
    const route = await requireRoute(harnessConfig, "embedded");
    if (route.authProfileId !== "openai:work") {
      throw new Error("missing test plugin harness profile route");
    }
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      keyRef: { source: "env" as const, provider: "default", id: "OPENAI_WORK_KEY" },
    };
    let activeKey = "work-key";
    const resolveHarnessAuth = vi.fn(async () =>
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:work",
        credential,
        resolvedAuth: profileAuth("openai:work", activeKey),
      }),
    );
    const authFingerprint = requireFingerprint(
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:work",
        credential,
        resolvedAuth: profileAuth("openai:work", activeKey),
      }),
    );
    const deps = {
      ...pluginArtifactDeps(),
      ensureAuthProfileStore: profileStore("openai:work", credential),
      resolveAgentHarnessAuthBindingFingerprint: resolveHarnessAuth,
    };
    const binding = await createBinding(
      route,
      {
        authProfileId: "openai:work",
        authFingerprint,
        agentHarnessId: "codex",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      },
      deps,
    );

    await expect(revalidate(binding, harnessConfig, deps)).resolves.toBe(binding.execution);

    activeKey = "replacement-key";
    await expect(revalidate(binding, harnessConfig, deps)).resolves.toBeNull();
    expect(resolveHarnessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ harnessId: "codex", authProfileId: "openai:work" }),
    );
  });

  it("refuses to mint an AWS SDK owner without exact principal proof", async () => {
    const bedrockConfig = {
      agents: {
        defaults: { model: "amazon-bedrock/us.anthropic.claude-sonnet-4-6" },
      },
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            api: "bedrock-converse-stream",
            auth: "aws-sdk",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const route = await requireRoute(bedrockConfig, "embedded");
    const auth = { source: "aws-sdk default chain", mode: "aws-sdk" as const };
    const fingerprint = () =>
      fingerprintAwsSdkRuntimeOwner({
        provider: route.provider,
        backendId: route.agentHarnessRuntimeOverride ?? "openclaw",
        auth,
      });
    try {
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_SESSION_TOKEN", "");
      vi.stubEnv("AWS_PROFILE", "work");
      expect(fingerprint()).toBeUndefined();

      vi.stubEnv("AWS_PROFILE", "");
      expect(fingerprint()).toBeUndefined();

      await expect(createBinding(route, {})).rejects.toThrow(
        "did not report one exact execution owner",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed after the configured route changes", async () => {
    const binding = await bindingFor(config());
    const changed = config("anthropic/claude-opus-4-8");

    const route = await revalidate(binding, changed);

    expect(route).toBeNull();
  });

  it.each([
    {
      name: "an owner is added",
      ownerIds: ["provider-owner", "replacement-owner"],
      records: [pluginRecord("provider-owner"), pluginRecord("replacement-owner")],
    },
    { name: "an owner is removed", ownerIds: [] as string[], records: [] },
  ])("invalidates a strict credential when $name", async ({ ownerIds, records }) => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    pluginRegistryState.providerOwnerIds = ownerIds;
    pluginRegistryState.records = records;

    const route = await revalidate(binding, baseConfig, authDeps());

    expect(route).toBeNull();
  });

  it("invalidates a strict credential when its owning runtime is removed", async () => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    pluginRegistryState.records = [];

    const route = await revalidate(binding, baseConfig, authDeps());

    expect(route).toBeNull();
  });

  it.each([
    {
      name: "runtime source",
      replacement: {
        rootDir: "/replacement/provider-owner",
        source: "/replacement/provider-owner/index.js",
        manifestPath: "/replacement/provider-owner/openclaw.plugin.json",
      },
    },
    { name: "package version", replacement: { packageVersion: "2.0.0" } },
    {
      name: "installed artifact identity",
      replacement: { installRecordHash: "provider-owner-install-v2" },
    },
  ])("invalidates a strict credential when its owner $name changes", async ({ replacement }) => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    pluginRegistryState.records = [pluginRecord("provider-owner", replacement)];

    const route = await revalidate(binding, baseConfig, authDeps());

    expect(route).toBeNull();
  });

  it.each([
    {
      name: "path/dev executable",
      origin: "config" as const,
      sourcePath: "src/index.ts",
      installRecordHash: undefined,
    },
    {
      name: "installed executable",
      origin: "global" as const,
      sourcePath: "dist/index.js",
      installRecordHash: "provider-owner-install-v1",
    },
  ])(
    "invalidates a strict credential after an in-place $name change with stable registry identity",
    async ({ origin, sourcePath, installRecordHash }) => {
      const runtimePath = "dist/index.js";
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openclaw-plugin-"));
      try {
        const rootDir = path.join(tempDir, "provider-owner");
        const source = path.join(rootDir, sourcePath);
        const manifestPath = path.join(rootDir, "openclaw.plugin.json");
        const packageJsonPath = path.join(rootDir, "package.json");
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, "export const sourceRevision = 1;\n", "utf8");
        const runtimeSource = path.join(rootDir, runtimePath);
        fs.mkdirSync(path.dirname(runtimeSource), { recursive: true });
        fs.writeFileSync(runtimeSource, "export const runtimeRevision = 1;\n", "utf8");
        fs.writeFileSync(manifestPath, '{"id":"provider-owner"}\n', "utf8");
        fs.writeFileSync(packageJsonPath, '{"name":"@openclaw/provider-owner"}\n', "utf8");

        const record = pluginRecord("provider-owner", {
          origin,
          rootDir,
          manifestPath,
          source,
          installRecordHash,
          packageJson: { path: packageJsonPath, hash: "provider-owner-package-v1" },
        });
        const codexRootDir = path.join(tempDir, "codex");
        const codexSource = path.join(codexRootDir, "index.js");
        const codexManifestPath = path.join(codexRootDir, "openclaw.plugin.json");
        const codexPackageJsonPath = path.join(codexRootDir, "package.json");
        fs.mkdirSync(codexRootDir, { recursive: true });
        fs.writeFileSync(codexSource, "export const runtime = 'codex';\n", "utf8");
        fs.writeFileSync(codexManifestPath, '{"id":"codex"}\n', "utf8");
        fs.writeFileSync(codexPackageJsonPath, '{"name":"@openclaw/codex"}\n', "utf8");
        const codexRecord = pluginRecord("codex", {
          rootDir: codexRootDir,
          manifestPath: codexManifestPath,
          source: codexSource,
          packageJson: { path: codexPackageJsonPath, hash: "codex-package-v1" },
        });
        const loadPluginRegistrySnapshot = vi.fn(() => ({ plugins: [record, codexRecord] }));
        const deps = {
          ...authDeps(),
          loadPluginRegistrySnapshot,
        };
        const baseConfig = config();
        const binding = await bindingFor(baseConfig, deps);

        await expect(
          resolvePersistentApplyInference({
            binding,
            runtime,
            deps: { ...configSnapshot(baseConfig), ...deps },
          }),
        ).resolves.toBe(binding.execution);

        fs.writeFileSync(runtimeSource, "export const runtimeRevision = 2;\n", "utf8");

        await expect(
          resolvePersistentApplyInference({
            binding,
            runtime,
            deps: { ...configSnapshot(baseConfig), ...deps },
          }),
        ).resolves.toBeNull();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps the frozen verified route across unrelated channel config changes", async () => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    const changed = {
      ...baseConfig,
      channels: { discord: { enabled: true } },
      plugins: { entries: { discord: { enabled: true } } },
    } satisfies OpenClawConfig;

    const route = await revalidate(binding, changed, authDeps());

    expect(route).toBe(binding.execution);
    expect(route?.runConfig).toMatchObject(baseConfig);
    expect(route?.runConfig.agents?.entries).toEqual({ openclaw: {} });
    expect(route?.runConfig).not.toBe(baseConfig);
  });

  it("fails closed when the selected credential content changes", async () => {
    const binding = await bindingFor(config());

    const route = await revalidate(binding, config(), authDeps("replacement-key"));

    expect(route).toBeNull();
  });

  it.each([
    { name: "plugins.allow is omitted", plugins: {}, remainsValid: true },
    { name: "plugins.allow is empty", plugins: { allow: [] }, remainsValid: true },
    {
      name: "plugins.allow includes the owner",
      plugins: { allow: ["provider-owner", "codex"] },
      remainsValid: true,
    },
    {
      name: "plugins.allow excludes the owner",
      plugins: { allow: ["discord"] },
      remainsValid: false,
    },
    { name: "plugins.enabled is false", plugins: { enabled: false }, remainsValid: false },
    {
      name: "plugins.deny includes the owner",
      plugins: { deny: ["provider-owner"] },
      remainsValid: false,
    },
    {
      name: "the owner entry is disabled",
      plugins: { entries: { "provider-owner": { enabled: false } } },
      remainsValid: false,
    },
  ])("projects the provider-owner policy when $name", async ({ plugins, remainsValid }) => {
    const baseConfig = { ...config(), plugins: { allow: [] } } satisfies OpenClawConfig;
    const binding = await bindingFor(baseConfig);
    const changed = { ...config(), plugins } satisfies OpenClawConfig;

    const route = await revalidate(binding, changed, authDeps());

    expect(route).toBe(remainsValid ? binding.execution : null);
  });
});
