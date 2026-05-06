import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const storeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
  loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles: {} })),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(() => ({ version: 1, profiles: {} })),
}));

const credentialMocks = vi.hoisted(() => ({
  resolvePiCredentialMapFromStore: vi.fn(() => ({})),
}));

const discoveryCoreMocks = vi.hoisted(() => ({
  addEnvBackedPiCredentials: vi.fn((credentials: unknown) => credentials),
  scrubLegacyStaticAuthJsonEntriesForDiscovery: vi.fn(),
}));

const syntheticAuthMocks = vi.hoisted(() => ({
  resolveRuntimeSyntheticAuthProviderRefs: vi.fn(() => []),
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

vi.mock("./auth-profiles/store.js", () => storeMocks);

vi.mock("./pi-auth-credentials.js", () => credentialMocks);

vi.mock("./pi-auth-discovery-core.js", () => discoveryCoreMocks);

vi.mock("./synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs:
    syntheticAuthMocks.resolveRuntimeSyntheticAuthProviderRefs,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin,
}));

import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";
import { resolvePiCredentialsForDiscovery } from "./pi-auth-discovery.js";

describe("resolvePiCredentialsForDiscovery external CLI scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("threads scoped external CLI discovery into writable auth store loading", () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: ["fireworks"],
    });

    resolvePiCredentialsForDiscovery("/tmp/openclaw-agent", {
      config: cfg,
      env: {},
      externalCli,
    });

    expect(storeMocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-agent", {
      allowKeychainPrompt: false,
      config: cfg,
      externalCli,
    });
    expect(storeMocks.loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it("preserves scoped external CLI discovery for read-only auth store loading", () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: ["fireworks"],
    });

    resolvePiCredentialsForDiscovery("/tmp/openclaw-agent", {
      config: cfg,
      env: {},
      externalCli,
      readOnly: true,
    });

    expect(storeMocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/openclaw-agent", {
      allowKeychainPrompt: false,
      config: cfg,
      externalCli,
      readOnly: true,
    });
  });

  it("can skip runtime external auth overlays and scope synthetic auth discovery", () => {
    resolvePiCredentialsForDiscovery("/tmp/openclaw-agent", {
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
      context: {
        config: undefined,
        provider: "fireworks",
        providerConfig: undefined,
      },
    });
  });
});
