import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintAuthProfileCredential,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/types.js";
import { resolveCrestodianConfiguredRouteFromConfig } from "./inference-route.js";
import { resolveCrestodianInferenceForPersistentApply } from "./setup-inference.js";
import {
  createCrestodianVerifiedInferenceBinding,
  resolveCrestodianVerifiedInferenceRoute,
  type CrestodianVerifiedInferenceDeps,
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
  pluginRegistryState.providerOwnerIds = ["provider-owner"];
  pluginRegistryState.records = [pluginRecord("provider-owner"), pluginRecord("codex")];
  harnessRuntimeArtifactState.id = "codex-app-server";
  harnessRuntimeArtifactState.fingerprint = "codex-runtime-v1";
  harnessRuntimeArtifactState.valid = true;
  harnessRuntimeArtifactState.ownsAuthBootstrap = true;
});

function authDeps(apiKey = "verified-key") {
  return {
    ensureAuthProfileStore: vi.fn(() => ({
      version: 1,
      profiles: { "openai:verified": { ...profile, key: apiKey } },
    })) as never,
    resolveApiKeyForProvider: vi.fn(async () => ({
      apiKey,
      profileId: "openai:verified",
      source: "profile:openai:verified",
      mode: "api-key" as const,
    })),
    resolveAgentHarnessAuthBindingFingerprint: vi.fn(
      async (
        params: Parameters<
          NonNullable<CrestodianVerifiedInferenceDeps["resolveAgentHarnessAuthBindingFingerprint"]>
        >[0],
      ) => {
        const credential = params.authProfileStore.profiles[params.authProfileId];
        return credential
          ? fingerprintResolvedAuthProfileCredential({
              profileId: params.authProfileId,
              credential,
              resolvedAuth: {
                apiKey,
                profileId: params.authProfileId,
                source: `profile:${params.authProfileId}`,
                mode: "api-key",
              },
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

async function bindingFor(
  baseConfig: OpenClawConfig,
  deps: CrestodianVerifiedInferenceDeps = { ...authDeps(), ...pluginArtifactDeps() },
) {
  const route = await resolveCrestodianConfiguredRouteFromConfig(baseConfig);
  if (!route) {
    throw new Error("missing test route");
  }
  const authFingerprint = fingerprintAuthProfileCredential({
    profileId: "openai:verified",
    credential: profile,
  });
  if (!authFingerprint) {
    throw new Error("missing test auth fingerprint");
  }
  const agentHarnessId =
    route.runner === "embedded"
      ? route.agentHarnessRuntimeOverride === "auto"
        ? "openclaw"
        : route.agentHarnessRuntimeOverride
      : undefined;
  return await createCrestodianVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      authProfileId: "openai:verified",
      authFingerprint,
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
  });
}

describe("verified Crestodian inference binding", () => {
  it("invalidates an identity-less OAuth binding when its grant changes", async () => {
    const oauthConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8@anthropic:oauth" } },
      auth: { profiles: { "anthropic:oauth": { provider: "anthropic", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(oauthConfig);
    if (!route) {
      throw new Error("missing test OAuth route");
    }
    const credential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "access-a",
      refresh: "refresh-a",
      expires: 1,
    };
    const authFingerprint = fingerprintAuthProfileCredential({
      profileId: "anthropic:oauth",
      credential,
    });
    if (!authFingerprint) {
      throw new Error("missing test OAuth fingerprint");
    }
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        authProfileId: "anthropic:oauth",
        authFingerprint,
        agentHarnessId: "openclaw",
      },
      deps: {
        ...pluginArtifactDeps(),
        ensureAuthProfileStore: vi.fn(() => ({
          version: 1,
          profiles: { "anthropic:oauth": credential },
        })) as never,
      },
    });

    const current = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: oauthConfig,
      })) as never,
      ensureAuthProfileStore: vi.fn(() => ({
        version: 1,
        profiles: {
          "anthropic:oauth": {
            ...credential,
            access: "access-b",
            refresh: "refresh-b",
          },
        },
      })) as never,
    });

    expect(current).toBeNull();
  });

  it("rejects a binding when no credential fingerprint can be observed", async () => {
    const route = await resolveCrestodianConfiguredRouteFromConfig(config());
    if (!route) {
      throw new Error("missing test route");
    }

    await expect(
      createCrestodianVerifiedInferenceBinding({
        configuredRoute: route,
        executionRoute: route,
        auth: {
          authProfileId: "openai:verified",
          authFingerprint: "reported-owner",
          agentHarnessId: "codex",
          runtimeOwnerKind: "plugin-harness",
          runtimeOwnerId: "codex",
          ...codexRuntimeArtifactAuth,
        },
        deps: {
          ...pluginArtifactDeps(),
          ensureAuthProfileStore: vi.fn(() => ({
            version: 1,
            profiles: {
              "openai:verified": {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "file", provider: "vault", id: "/openai/key" },
              },
            },
          })) as never,
          resolveAgentHarnessAuthBindingFingerprint: vi.fn(async () => {
            throw new Error("active secret unavailable");
          }),
        },
      }),
    ).rejects.toThrow("active secret unavailable");
  });

  it("accepts and revalidates an opaque CLI owner emitted after a successful turn", async () => {
    const cliConfig = {
      agents: { defaults: { model: "claude-cli/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(cliConfig);
    if (!route || route.runner !== "cli") {
      throw new Error("missing test CLI route");
    }
    const resolveOwner = vi.fn(async () => "opaque-cli-owner");
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        runtimeOwnerFingerprint: "opaque-cli-owner",
        runtimeOwnerKind: "cli-runtime",
        runtimeOwnerId: "claude-cli",
        ...cliRuntimeArtifactAuth,
      },
      deps: {
        ...pluginArtifactDeps(),
        ...cliRuntimeArtifactDeps(),
        resolveCliRuntimeOwnerFingerprint: resolveOwner,
      },
    });

    expect(binding.auth).toMatchObject({
      authFingerprint: "opaque-cli-owner",
      proofKind: "runtime-owner",
    });
    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: cliConfig,
        })) as never,
        ...cliRuntimeArtifactDeps(),
        resolveCliRuntimeOwnerFingerprint: resolveOwner,
      }),
    ).resolves.toBe(binding.execution);

    resolveOwner.mockResolvedValue("replacement-owner");
    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: cliConfig,
        })) as never,
        ...cliRuntimeArtifactDeps(),
        resolveCliRuntimeOwnerFingerprint: resolveOwner,
      }),
    ).resolves.toBeNull();
  });

  it("invalidates an opaque CLI owner after backend config drift", async () => {
    const cliConfig = {
      agents: {
        defaults: {
          model: "claude-cli/claude-opus-4-8",
          cliBackends: { "claude-cli": { command: "claude" } },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: {
        defaults: {
          ...cliConfig.agents.defaults,
          cliBackends: { "claude-cli": { command: "/opt/other/claude" } },
        },
      },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(cliConfig);
    if (!route || route.runner !== "cli") {
      throw new Error("missing test CLI route");
    }
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        runtimeOwnerFingerprint: "opaque-cli-owner",
        runtimeOwnerKind: "cli-runtime",
        runtimeOwnerId: "claude-cli",
        ...cliRuntimeArtifactAuth,
      },
      deps: {
        ...pluginArtifactDeps(),
        ...cliRuntimeArtifactDeps(),
        resolveCliRuntimeOwnerFingerprint: vi.fn(async () => "opaque-cli-owner"),
      },
    });

    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: changedConfig,
        })) as never,
        resolveCliRuntimeOwnerFingerprint: vi.fn(async () => "opaque-cli-owner"),
      }),
    ).resolves.toBeNull();
  });

  it("invalidates a strict CLI credential when its package artifact changes", async () => {
    const cliConfig = {
      agents: { defaults: { model: "claude-cli/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(cliConfig);
    if (!route || route.runner !== "cli") {
      throw new Error("missing test CLI route");
    }
    const resolveAuth = vi.fn(() => "strict-cli-credential");
    const resolveArtifact = vi.fn(async () => "claude-cli-artifact-v1");
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        authFingerprint: "strict-cli-credential",
        ...cliRuntimeArtifactAuth,
      },
      deps: {
        ...pluginArtifactDeps(),
        resolveCliAuthBindingFingerprint: resolveAuth,
        resolveCliRuntimeArtifactFingerprint: resolveArtifact,
      },
    });

    resolveArtifact.mockResolvedValue("claude-cli-artifact-v2");
    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: cliConfig,
        })) as never,
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
    const route = await resolveCrestodianConfiguredRouteFromConfig(cliConfig);
    if (!route || route.runner !== "cli" || route.authProfileId !== profileId) {
      throw new Error("missing test CLI SecretRef route");
    }
    const credential = {
      type: "api_key" as const,
      provider: "claude-cli",
      keyRef: { source: "file" as const, provider: "vault", id: "/claude/work" },
    };
    let activeKey = "materialized-a";
    const ensureStore = vi.fn(() => ({
      version: 1,
      profiles: { [profileId]: credential },
    })) as never;
    const resolveAuth = vi.fn(async () => ({
      apiKey: activeKey,
      profileId,
      source: `profile:${profileId}`,
      mode: "api-key" as const,
    }));
    const resolveBinding = vi.fn(
      (params: { resolvedAuth?: { apiKey?: string } }) =>
        params.resolvedAuth?.apiKey && `strict:${params.resolvedAuth.apiKey}`,
    );
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        authProfileId: profileId,
        authFingerprint: "strict:materialized-a",
        ...cliRuntimeArtifactAuth,
      },
      deps: {
        ...pluginArtifactDeps(),
        ...cliRuntimeArtifactDeps(),
        ensureAuthProfileStore: ensureStore,
        resolveApiKeyForProvider: resolveAuth,
        resolveCliAuthBindingFingerprint: resolveBinding as never,
      },
    });

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
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: cliConfig,
        })) as never,
        ...cliRuntimeArtifactDeps(),
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
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!route || route.runner !== "embedded" || route.agentHarnessRuntimeOverride !== "codex") {
      throw new Error("missing test plugin harness route");
    }
    const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: route.provider,
      backendId: route.agentHarnessRuntimeOverride,
      runtimeArtifactFingerprint: codexRuntimeArtifactAuth.runtimeArtifactFingerprint,
    });
    if (!runtimeOwnerFingerprint) {
      throw new Error("missing test harness owner");
    }
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        agentHarnessId: route.agentHarnessRuntimeOverride,
        runtimeOwnerFingerprint,
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: route.agentHarnessRuntimeOverride,
        ...codexRuntimeArtifactAuth,
      },
      deps: pluginArtifactDeps(),
    });

    expect(binding.ownerPluginIds).toEqual(["codex", "provider-owner"]);

    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: harnessConfig,
        })) as never,
      }),
    ).resolves.toBe(binding.execution);
  });

  it("invalidates a plugin-harness binding when its child runtime artifact changes", async () => {
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!route || route.runner !== "embedded") {
      throw new Error("missing test plugin harness route");
    }
    const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: route.provider,
      backendId: "codex",
      runtimeArtifactFingerprint: codexRuntimeArtifactAuth.runtimeArtifactFingerprint,
    });
    if (!runtimeOwnerFingerprint) {
      throw new Error("missing test harness owner");
    }
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        agentHarnessId: "codex",
        runtimeOwnerFingerprint,
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      },
      deps: pluginArtifactDeps(),
    });

    harnessRuntimeArtifactState.fingerprint = "codex-runtime-v2";
    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: harnessConfig,
        })) as never,
      }),
    ).resolves.toBeNull();
  });

  it("requires a child runtime artifact for credential-backed plugin harness inference", async () => {
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5@openai:verified",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      auth: {
        profiles: { "openai:verified": { provider: "openai", mode: "api_key" } },
      },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!route || route.runner !== "embedded") {
      throw new Error("missing test plugin harness route");
    }
    const authFingerprint = fingerprintAuthProfileCredential({
      profileId: "openai:verified",
      credential: profile,
    });
    if (!authFingerprint) {
      throw new Error("missing test auth fingerprint");
    }

    await expect(
      createCrestodianVerifiedInferenceBinding({
        configuredRoute: route,
        executionRoute: route,
        auth: {
          authProfileId: "openai:verified",
          authFingerprint,
        },
        deps: { ...authDeps(), ...pluginArtifactDeps() },
      }),
    ).rejects.toThrow("did not report its exact runtime artifact");

    await expect(
      createCrestodianVerifiedInferenceBinding({
        configuredRoute: route,
        executionRoute: route,
        auth: {
          authProfileId: "openai:verified",
          authFingerprint,
          agentHarnessId: "codex",
          runtimeOwnerKind: "plugin-harness",
          runtimeOwnerId: "codex",
        },
        deps: { ...authDeps(), ...pluginArtifactDeps() },
      }),
    ).rejects.toThrow("did not report its exact runtime artifact");

    await expect(
      createCrestodianVerifiedInferenceBinding({
        configuredRoute: route,
        executionRoute: route,
        auth: {
          authProfileId: "openai:verified",
          authFingerprint,
          agentHarnessId: "codex",
          runtimeOwnerKind: "plugin-harness",
          runtimeOwnerId: "codex",
          ...codexRuntimeArtifactAuth,
        },
        deps: { ...authDeps(), ...pluginArtifactDeps() },
      }),
    ).resolves.toMatchObject({
      execution: { agentHarnessRuntimeOverride: "codex" },
      auth: { authFingerprint, runtimeArtifactFingerprint: "codex-runtime-v1" },
    });
  });

  it("freezes the actual successful harness when configured policy is auto", async () => {
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const resolved = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!resolved || resolved.runner !== "embedded") {
      throw new Error("missing test plugin harness route");
    }
    const configuredRoute = {
      ...resolved,
      agentHarnessRuntimeOverride: "auto",
    } satisfies typeof resolved;
    const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: configuredRoute.provider,
      backendId: "codex",
      runtimeArtifactFingerprint: codexRuntimeArtifactAuth.runtimeArtifactFingerprint,
    });
    if (!runtimeOwnerFingerprint) {
      throw new Error("missing test harness owner");
    }

    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute,
      executionRoute: configuredRoute,
      auth: {
        agentHarnessId: "codex",
        runtimeOwnerFingerprint,
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      },
      deps: pluginArtifactDeps(),
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
    const resolved = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!resolved || resolved.runner !== "embedded") {
      throw new Error("missing test embedded route");
    }
    const configuredRoute = {
      ...resolved,
      agentHarnessRuntimeOverride: "auto",
    } satisfies typeof resolved;
    const authFingerprint = fingerprintResolvedProviderAuth({
      apiKey: "verified-key",
      profileId: "openai:verified",
      source: "profile:openai:verified",
      mode: "api-key",
    });
    if (!authFingerprint) {
      throw new Error("missing test auth fingerprint");
    }

    await expect(
      createCrestodianVerifiedInferenceBinding({
        configuredRoute,
        executionRoute: configuredRoute,
        auth: { authProfileId: "openai:verified", authFingerprint },
        deps: authDeps(),
      }),
    ).rejects.toThrow("did not report its exact agent harness");

    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute,
      executionRoute: configuredRoute,
      auth: {
        authProfileId: "openai:verified",
        authFingerprint,
        agentHarnessId: "openclaw",
      },
      deps: { ...authDeps(), ...pluginArtifactDeps() },
    });

    expect(binding.execution).toMatchObject({ agentHarnessRuntimeOverride: "openclaw" });
    expect(binding.auth.agentHarnessId).toBe("openclaw");
  });

  it("rejects an opaque harness with no trusted manifest owner", async () => {
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const resolved = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!resolved || resolved.runner !== "embedded") {
      throw new Error("missing test plugin harness route");
    }
    const configuredRoute = {
      ...resolved,
      agentHarnessRuntimeOverride: "auto",
    } satisfies typeof resolved;
    const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: configuredRoute.provider,
      backendId: "unowned-harness",
      runtimeArtifactFingerprint: codexRuntimeArtifactAuth.runtimeArtifactFingerprint,
    });
    if (!runtimeOwnerFingerprint) {
      throw new Error("missing test harness owner");
    }

    await expect(
      createCrestodianVerifiedInferenceBinding({
        configuredRoute,
        executionRoute: configuredRoute,
        auth: {
          agentHarnessId: "unowned-harness",
          runtimeOwnerFingerprint,
          runtimeOwnerKind: "plugin-harness",
          runtimeOwnerId: "unowned-harness",
          ...codexRuntimeArtifactAuth,
        },
        deps: {
          validateAgentHarnessRuntimeArtifact: vi.fn(async () => true),
        },
      }),
    ).rejects.toThrow("no trusted manifest owner");
  });

  it("invalidates a plugin-harness owner when its manifest-owned config drifts", async () => {
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      plugins: { entries: { codex: { config: { appServer: { command: "codex" } } } } },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!route || route.runner !== "embedded" || route.agentHarnessRuntimeOverride !== "codex") {
      throw new Error("missing test plugin harness route");
    }
    const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: route.provider,
      backendId: route.agentHarnessRuntimeOverride,
      runtimeArtifactFingerprint: codexRuntimeArtifactAuth.runtimeArtifactFingerprint,
    });
    if (!runtimeOwnerFingerprint) {
      throw new Error("missing test harness owner");
    }
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        agentHarnessId: route.agentHarnessRuntimeOverride,
        runtimeOwnerFingerprint,
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: route.agentHarnessRuntimeOverride,
        ...codexRuntimeArtifactAuth,
      },
      deps: pluginArtifactDeps(),
    });
    const changed = structuredClone(harnessConfig);
    changed.plugins!.entries!.codex!.config = { appServer: { command: "/opt/other/codex" } };

    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: changed,
        })) as never,
      }),
    ).resolves.toBeNull();
  });

  it("keeps core-bootstrap plugin harnesses on exact raw-profile revalidation", async () => {
    harnessRuntimeArtifactState.ownsAuthBootstrap = false;
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5@openai:verified",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!route || route.runner !== "embedded") {
      throw new Error("missing test plugin harness route");
    }
    const authFingerprint = fingerprintResolvedAuthProfileCredential({
      profileId: "openai:verified",
      credential: profile,
      resolvedAuth: {
        apiKey: "verified-key",
        profileId: "openai:verified",
        source: "profile:openai:verified",
        mode: "api-key",
      },
    });
    if (!authFingerprint) {
      throw new Error("missing test auth fingerprint");
    }
    const resolveAuth = vi.fn(async () => ({
      apiKey: "verified-key",
      profileId: "openai:verified",
      source: "profile:openai:verified",
      mode: "api-key" as const,
    }));
    const deps = {
      ...pluginArtifactDeps(),
      ensureAuthProfileStore: vi.fn(() => ({
        version: 1,
        profiles: { "openai:verified": profile },
      })) as never,
      resolveApiKeyForProvider: resolveAuth,
    };
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        authProfileId: "openai:verified",
        authFingerprint,
        agentHarnessId: "codex",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      },
      deps,
    });

    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        ...deps,
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: harnessConfig,
        })) as never,
      }),
    ).resolves.toBe(binding.execution);
    expect(resolveAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileId: "openai:verified",
        lockedProfile: true,
        secretSentinels: false,
      }),
    );
  });

  it("invalidates a plugin-harness binding when its forwarded SecretRef changes", async () => {
    const harnessConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.5@openai:work",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      auth: { profiles: { "openai:work": { provider: "openai", mode: "api_key" } } },
    } satisfies OpenClawConfig;
    const route = await resolveCrestodianConfiguredRouteFromConfig(harnessConfig);
    if (!route || route.runner !== "embedded" || route.authProfileId !== "openai:work") {
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
        resolvedAuth: {
          apiKey: activeKey,
          profileId: "openai:work",
          source: "profile:openai:work",
          mode: "api-key",
        },
      }),
    );
    const authFingerprint = fingerprintResolvedAuthProfileCredential({
      profileId: "openai:work",
      credential,
      resolvedAuth: {
        apiKey: "work-key",
        profileId: "openai:work",
        source: "profile:openai:work",
        mode: "api-key",
      },
    });
    if (!authFingerprint) {
      throw new Error("missing test profile owner");
    }
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth: {
        authProfileId: "openai:work",
        authFingerprint,
        agentHarnessId: "codex",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      },
      deps: {
        ...pluginArtifactDeps(),
        ensureAuthProfileStore: vi.fn(() => ({
          version: 1,
          profiles: { "openai:work": credential },
        })) as never,
        resolveAgentHarnessAuthBindingFingerprint: resolveHarnessAuth,
      },
    });

    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: harnessConfig,
        })) as never,
        ensureAuthProfileStore: vi.fn(() => ({
          version: 1,
          profiles: { "openai:work": credential },
        })) as never,
        resolveAgentHarnessAuthBindingFingerprint: resolveHarnessAuth,
      }),
    ).resolves.toBe(binding.execution);

    activeKey = "replacement-key";
    await expect(
      resolveCrestodianVerifiedInferenceRoute(binding, {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: harnessConfig,
        })) as never,
        ensureAuthProfileStore: vi.fn(() => ({
          version: 1,
          profiles: { "openai:work": credential },
        })) as never,
        resolveAgentHarnessAuthBindingFingerprint: resolveHarnessAuth,
      }),
    ).resolves.toBeNull();
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
    const route = await resolveCrestodianConfiguredRouteFromConfig(bedrockConfig);
    if (!route || route.runner !== "embedded") {
      throw new Error("missing test AWS route");
    }
    const auth = { source: "aws-sdk default chain", mode: "aws-sdk" as const };
    try {
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_SESSION_TOKEN", "");
      vi.stubEnv("AWS_PROFILE", "work");
      expect(
        fingerprintAwsSdkRuntimeOwner({
          provider: route.provider,
          backendId: route.agentHarnessRuntimeOverride,
          auth,
        }),
      ).toBeUndefined();

      vi.stubEnv("AWS_PROFILE", "");
      expect(
        fingerprintAwsSdkRuntimeOwner({
          provider: route.provider,
          backendId: route.agentHarnessRuntimeOverride,
          auth,
        }),
      ).toBeUndefined();

      await expect(
        createCrestodianVerifiedInferenceBinding({
          configuredRoute: route,
          executionRoute: route,
          auth: {},
        }),
      ).rejects.toThrow("did not report one exact execution owner");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed after the configured route changes", async () => {
    const binding = await bindingFor(config());
    const changed = config("anthropic/claude-opus-4-8");

    const route = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: changed,
      })) as never,
    });

    expect(route).toBeNull();
  });

  it.each([
    {
      name: "an owner is added",
      ownerIds: ["provider-owner", "replacement-owner"],
      records: [pluginRecord("provider-owner"), pluginRecord("replacement-owner")],
    },
    {
      name: "an owner is removed",
      ownerIds: [] as string[],
      records: [] as Array<Record<string, unknown>>,
    },
  ])("invalidates a strict credential when $name", async ({ ownerIds, records }) => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    pluginRegistryState.providerOwnerIds = ownerIds;
    pluginRegistryState.records = records;

    const route = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: baseConfig,
      })) as never,
      ...authDeps(),
    });

    expect(route).toBeNull();
  });

  it("invalidates a strict credential when its owning runtime is removed", async () => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    pluginRegistryState.records = [];

    const route = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: baseConfig,
      })) as never,
      ...authDeps(),
    });

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
    {
      name: "package version",
      replacement: { packageVersion: "2.0.0" },
    },
    {
      name: "installed artifact identity",
      replacement: { installRecordHash: "provider-owner-install-v2" },
    },
  ])("invalidates a strict credential when its owner $name changes", async ({ replacement }) => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    pluginRegistryState.records = [pluginRecord("provider-owner", replacement)];

    const route = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: baseConfig,
      })) as never,
      ...authDeps(),
    });

    expect(route).toBeNull();
  });

  it.each([
    {
      name: "path/dev executable",
      origin: "config" as const,
      sourcePath: "src/index.ts",
      runtimePath: "dist/index.js",
      installRecordHash: undefined,
    },
    {
      name: "installed executable",
      origin: "global" as const,
      sourcePath: "dist/index.js",
      runtimePath: "dist/index.js",
      installRecordHash: "provider-owner-install-v1",
    },
  ])(
    "invalidates a strict credential after an in-place $name change with stable registry identity",
    async ({ origin, sourcePath, runtimePath, installRecordHash }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-crestodian-plugin-"));
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
          resolveCrestodianInferenceForPersistentApply({
            binding,
            runtime,
            deps: {
              readConfigFileSnapshot: vi.fn(async () => ({
                exists: true,
                valid: true,
                config: baseConfig,
              })) as never,
              ...deps,
            },
          }),
        ).resolves.toBe(binding.execution);

        fs.writeFileSync(runtimeSource, "export const runtimeRevision = 2;\n", "utf8");

        await expect(
          resolveCrestodianInferenceForPersistentApply({
            binding,
            runtime,
            deps: {
              readConfigFileSnapshot: vi.fn(async () => ({
                exists: true,
                valid: true,
                config: baseConfig,
              })) as never,
              ...deps,
            },
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

    const route = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: changed,
      })) as never,
      ...authDeps(),
    });

    expect(route).toBe(binding.execution);
    expect(route?.runConfig).toEqual(baseConfig);
    expect(route?.runConfig).not.toBe(baseConfig);
  });

  it("fails closed when the selected credential content changes", async () => {
    const binding = await bindingFor(config());

    const route = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: config(),
      })) as never,
      ...authDeps("replacement-key"),
    });

    expect(route).toBeNull();
  });

  it.each([
    {
      name: "plugins.allow is omitted",
      plugins: {},
      remainsValid: true,
    },
    {
      name: "plugins.allow is empty",
      plugins: { allow: [] },
      remainsValid: true,
    },
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
    {
      name: "plugins.enabled is false",
      plugins: { enabled: false },
      remainsValid: false,
    },
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

    const route = await resolveCrestodianVerifiedInferenceRoute(binding, {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: changed,
      })) as never,
      ...authDeps(),
    });

    expect(route).toBe(remainsValid ? binding.execution : null);
  });
});
