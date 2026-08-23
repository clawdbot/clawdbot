/**
 * Runtime contract tests for auth profile forwarding.
 *
 * Attempt-execution composition is covered in command/attempt-execution.cli.test.ts.
 * This suite owns the provider-alias and runtime-plan matrix directly so each
 * case does not need to load the full agent-attempt graph.
 */
import {
  AUTH_PROFILE_RUNTIME_CONTRACT,
  createAuthAliasManifestRegistry,
  expectedForwardedAuthProfile,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenAIRuntimeProvider } from "./openai-routing.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import { resetProviderAuthAliasMapCacheForTest } from "./provider-auth-aliases.test-support.js";
import { buildAgentRuntimeAuthPlan } from "./runtime-plan/auth.js";

const pluginMetadataMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(() => undefined),
  loadPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

const workspaceDir = "/tmp/openclaw-auth-contract";
const authAliasMetadata = {
  plugins: createAuthAliasManifestRegistry().plugins,
};

function authAliasLookupParams(config: OpenClawConfig = {}) {
  return {
    config,
    workspaceDir,
  };
}

function resolveContractPlan(params: {
  provider: string;
  authProfileProvider: string;
  authProfileId: string;
  cfg?: OpenClawConfig;
  harnessRuntime?: string;
  authProfileSource?: "auto" | "user";
}) {
  const config = params.cfg ?? {};
  const aliasLookupParams = authAliasLookupParams(config);
  const plan = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: params.authProfileProvider,
    sessionAuthProfileId: params.authProfileId,
    sessionAuthProfileSource: params.authProfileSource,
    config,
    workspaceDir,
    harnessRuntime: params.harnessRuntime,
  });
  return {
    aliasLookupParams,
    plan,
    embeddedProvider: resolveOpenAIRuntimeProvider({
      provider: params.provider,
      harnessRuntime: params.harnessRuntime,
      authProfileProvider: plan.authProfileProviderForAuth,
      authProfileId: plan.forwardedAuthProfileId,
      config,
      workspaceDir,
    }),
  };
}

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openclaw.test/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

describe("Auth profile runtime contract - embedded OpenClaw and CLI adapter", () => {
  beforeEach(() => {
    resetProviderAuthAliasMapCacheForTest();
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockClear();
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockReset().mockReturnValue(authAliasMetadata);
  });

  it.each([
    [AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider],
    [
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
    ],
    [AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider, AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider],
    [
      AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
      AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
    ],
  ] as const)(
    "resolves %s through the provider auth alias resolver using contract metadata",
    (provider, expectedAuthProvider) => {
      expect(resolveProviderIdForAuth(provider, authAliasLookupParams())).toBe(
        expectedAuthProvider,
      );
    },
  );

  it("forwards a legacy OpenAI Codex auth profile to the codex-cli runtime plan", () => {
    const { aliasLookupParams, plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(plan.forwardedAuthProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        aliasLookupParams,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("forwards a legacy OpenAI Codex auth profile from the codex-cli auth alias", () => {
    const { aliasLookupParams, plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(plan.forwardedAuthProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        aliasLookupParams,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("forwards OpenAI auth profiles into the codex-cli runtime plan", () => {
    const { aliasLookupParams, plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProfileId,
    });

    expect(plan.forwardedAuthProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
        aliasLookupParams,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProfileId,
      }),
    );
  });

  it("does not leak an OpenAI auth profile into an unrelated CLI provider", () => {
    const { plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
  });

  it("does not let a configured Codex harness leak OpenAI auth into unrelated CLI providers", () => {
    const { plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "codex"),
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
  });

  it("forwards a legacy OpenAI Codex auth profile through the embedded OpenClaw plan", () => {
    const { plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(plan.forwardedAuthProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
  });

  it("accepts the codex-cli auth-provider alias on the embedded OpenAI plan", () => {
    const { aliasLookupParams, plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(plan.forwardedAuthProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        aliasLookupParams,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("forwards an OpenAI auth profile through an explicit OpenClaw plan", () => {
    const { embeddedProvider, plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "openclaw"),
      harnessRuntime: "openclaw",
    });

    expect(embeddedProvider).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider);
    expect(plan.forwardedAuthProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProfileId);
  });

  it("forwards a legacy OpenAI Codex auth profile through the default Codex harness plan", () => {
    const { plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      harnessRuntime: "codex",
    });

    expect(plan.forwardedAuthProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
  });

  it("routes explicit OpenAI OpenClaw plans with legacy Codex OAuth through OpenAI transport", () => {
    const { embeddedProvider, plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "openclaw"),
      harnessRuntime: "openclaw",
    });

    expect(embeddedProvider).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider);
    expect(plan.forwardedAuthProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
  });

  it("preserves OpenAI Codex auth profiles through the codex/* harness plan", () => {
    const { plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider, "codex"),
      harnessRuntime: "codex",
    });

    expect(plan.forwardedAuthProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
  });

  it("allows openai/* forced through the Codex harness to use OpenAI Codex OAuth profiles", () => {
    const { plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "codex"),
      harnessRuntime: "codex",
    });

    expect(plan.forwardedAuthProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
  });

  it("preserves the locked profile source after the session owner selects the Codex harness", () => {
    const { plan } = resolveContractPlan({
      provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      authProfileSource: "user",
      cfg: providerRuntimeConfig(AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider, "codex"),
      harnessRuntime: "codex",
    });

    expect(plan.forwardedAuthProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
    expect(plan.forwardedAuthProfileSource).toBe("user");
  });
});
