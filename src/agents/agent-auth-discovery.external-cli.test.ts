/** Tests external CLI scoping during agent auth-profile credential discovery. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const storeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
}));

const credentialMocks = vi.hoisted(() => ({
  resolveAgentCredentialMapFromStore: vi.fn(() => ({})),
}));

const discoveryCoreMocks = vi.hoisted(() => ({
  addEnvBackedAgentCredentials: vi.fn((credentials: unknown) => credentials),
}));

const syntheticAuthMocks = vi.hoisted(() => ({
  resolveRuntimeSyntheticAuthProviderRefs: vi.fn(() => []),
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

vi.mock("./auth-profiles/store.js", () => storeMocks);

vi.mock("./agent-auth-credentials.js", () => credentialMocks);

vi.mock("./agent-auth-discovery-core.js", () => discoveryCoreMocks);

vi.mock("./synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs:
    syntheticAuthMocks.resolveRuntimeSyntheticAuthProviderRefs,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin,
}));

import { resolveAgentDiscoveryAuthFacts } from "./agent-auth-discovery.js";
import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";

describe("resolveAgentDiscoveryAuthFacts external CLI scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialMocks.resolveAgentCredentialMapFromStore.mockReturnValue({});
  });

  it("threads scoped external CLI discovery into writable auth store loading", () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: ["fireworks"],
    });

    resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
      config: cfg,
      env: {},
      externalCli,
    });

    expect(storeMocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-agent", {
      allowKeychainPrompt: false,
      config: cfg,
      externalCli,
    });
  });

  it("reuses the active runtime generation for read-only auth discovery", () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: ["fireworks"],
    });

    resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
      config: cfg,
      env: {},
      externalCli,
      readOnly: true,
    });

    expect(storeMocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-agent", {
      allowKeychainPrompt: false,
      config: cfg,
      externalCli,
      readOnly: true,
    });
  });

  it("merges prepared ambient credentials without repeating ambient discovery", () => {
    credentialMocks.resolveAgentCredentialMapFromStore.mockReturnValue({
      fireworks: { type: "api_key", key: "agent-key" },
    });

    const { credentials } = resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
      ambientCredentials: {
        fireworks: { type: "api_key", key: "ambient-key" },
        "claude-cli": { type: "api_key", key: "synthetic-key" },
      },
      env: {},
      readOnly: true,
    });

    expect(credentials).toEqual({
      fireworks: { type: "api_key", key: "agent-key" },
      "claude-cli": { type: "api_key", key: "synthetic-key" },
    });
    expect(discoveryCoreMocks.addEnvBackedAgentCredentials).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveRuntimeSyntheticAuthProviderRefs).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
  });

  it("can skip runtime external auth overlays and scope synthetic auth discovery", () => {
    resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
      env: {},
      skipExternalAuthProfiles: true,
      syntheticAuthProviderRefs: ["fireworks"],
    });

    expect(storeMocks.ensureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledWith(
      "/tmp/openclaw-agent",
      {
        allowKeychainPrompt: false,
      },
    );
    expect(storeMocks.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveRuntimeSyntheticAuthProviderRefs).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
      provider: "fireworks",
      config: undefined,
      workspaceDir: undefined,
      env: {},
      context: {
        config: undefined,
        provider: "fireworks",
        providerConfig: undefined,
      },
    });
  });

  it.each(["oauth", "token"] as const)(
    "skips synthetic api-key fills under a %s provider pin",
    (auth) => {
      syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue({
        apiKey: "synthetic-key",
      });
      const cfg = {
        models: {
          providers: {
            fireworks: { auth, baseUrl: "https://example.invalid", models: [] },
          },
        },
      } satisfies OpenClawConfig;

      const { credentials } = resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
        config: cfg,
        env: {},
        syntheticAuthProviderRefs: ["fireworks"],
      });

      expect(credentials.fireworks).toBeUndefined();
      expect(syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
    },
  );
});
