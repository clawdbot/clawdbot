import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelAuthLabel } from "./model-auth-label.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  externalCliDiscoveryForProviderAuth: vi.fn(() => undefined),
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(),
  resolveUsableCustomProviderApiKey: vi.fn(() => null),
  resolveEnvApiKey: vi.fn<() => { apiKey: string; source: string } | null>(() => null),
  readClaudeCliCredentialsCached: vi.fn<(options?: unknown) => unknown>(() => null),
  readCodexCliCredentialsCached: vi.fn<(options?: unknown) => unknown>(() => null),
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  loadAuthProfileStoreWithoutExternalProfiles: mocks.loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
}));

vi.mock("./model-auth.js", () => ({
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));

vi.mock("./cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: mocks.readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
}));

describe("resolveModelAuthLabel", () => {
  beforeEach(() => {
    mocks.ensureAuthProfileStore.mockReset();
    mocks.externalCliDiscoveryForProviderAuth.mockReset();
    mocks.externalCliDiscoveryForProviderAuth.mockReturnValue(undefined);
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReset();
    mocks.resolveAuthProfileOrder.mockReset();
    mocks.resolveAuthProfileDisplayLabel.mockReset();
    mocks.resolveUsableCustomProviderApiKey.mockReset();
    mocks.resolveUsableCustomProviderApiKey.mockReturnValue(null);
    mocks.resolveEnvApiKey.mockReset();
    mocks.resolveEnvApiKey.mockReturnValue(null);
    mocks.readClaudeCliCredentialsCached.mockReset();
    mocks.readClaudeCliCredentialsCached.mockReturnValue(null);
    mocks.readCodexCliCredentialsCached.mockReset();
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);
  });

  it("does not include token value in label for token profiles", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", // pragma: allowlist secret
          tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
        },
      },
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["github-copilot:default"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("github-copilot:default");

    const label = resolveModelAuthLabel({
      provider: "github-copilot",
      cfg: {},
      sessionEntry: { authProfileOverride: "github-copilot:default" } as never,
    });

    expect(label).toBe("token (github-copilot:default)");
    expect(label).not.toContain("ghp_");
    expect(label).not.toContain("ref(");
  });

  it("does not include api-key value in label for api-key profiles", () => {
    const shortSecret = "abc123"; // pragma: allowlist secret
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: shortSecret,
        },
      },
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("openai:default");

    const label = resolveModelAuthLabel({
      provider: "openai",
      cfg: {},
      sessionEntry: { authProfileOverride: "openai:default" } as never,
    });

    expect(label).toBe("api-key (openai:default)");
    expect(label).not.toContain(shortSecret);
    expect(label).not.toContain("...");
  });

  it("shows oauth type with profile label", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
        },
      },
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:oauth"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("anthropic:oauth");

    const label = resolveModelAuthLabel({
      provider: "anthropic",
      cfg: {},
      sessionEntry: { authProfileOverride: "anthropic:oauth" } as never,
    });

    expect(label).toBe("oauth (anthropic:oauth)");
  });

  it("shows codex cli auth for codex provider without auth profiles", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    });

    const label = resolveModelAuthLabel({
      provider: "codex",
      cfg: {},
    });

    expect(label).toBe("oauth (codex-cli)");
    expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalledWith({
      ttlMs: 5_000,
      allowKeychainPrompt: false,
    });
  });

  it("shows claude cli auth for claude-cli provider without auth profiles", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "claude-cli",
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    });

    const label = resolveModelAuthLabel({
      provider: "claude-cli",
      cfg: {},
    });

    expect(label).toBe("oauth (claude-cli)");
    expect(mocks.readClaudeCliCredentialsCached).toHaveBeenCalledWith({
      ttlMs: 5_000,
      allowKeychainPrompt: false,
    });
  });

  it("can skip external auth profile overlays for status labels", () => {
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
        },
      },
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:oauth"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("anthropic:oauth");

    const label = resolveModelAuthLabel({
      provider: "anthropic",
      cfg: {},
      includeExternalProfiles: false,
    });

    expect(label).toBe("oauth (anthropic:oauth)");
    expect(mocks.loadAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledOnce();
    expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
  });

  it("resolves env labels with config and workspace scope", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveEnvApiKey.mockReturnValue({
      apiKey: "workspace-cloud-local-credentials",
      source: "workspace cloud credentials",
    });

    const cfg = { plugins: { allow: ["workspace-cloud"] } };
    const label = resolveModelAuthLabel({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
    });

    expect(label).toBe("api-key (workspace cloud credentials)");
    expect(mocks.resolveEnvApiKey).toHaveBeenCalledWith("workspace-cloud", process.env, {
      config: cfg,
      workspaceDir: "/tmp/workspace",
    });
  });
});
