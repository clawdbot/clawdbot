import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  sharedVerifiedInferenceConfig,
  mocks,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  advanceGatewayWizardToToken,
  type OpenClawConfig,
  type WizardPrompter,
} from "./chat-engine.test-support.js";

describe("SystemAgentChatEngine runtime", () => {
  it("hosts a channel setup wizard as chat turns", async () => {
    useTempStateDir();
    const wizardRuns: string[] = [];
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (channel: string, prompter: WizardPrompter) => {
        wizardRuns.push(channel);
        const token = await prompter.text({ message: "Bot token" });
        wizardRuns.push(`token:${token}`);
        const mode = await prompter.select({
          message: "DM mode",
          options: [
            { value: "pair", label: "Pairing" },
            { value: "open", label: "Open" },
          ],
        });
        wizardRuns.push(`mode:${mode}`);
      },
    });

    // Starting the wizard is not a write: it begins immediately, no approval step.
    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");
    // Text steps stay prose-only; only closed choices become typed questions.
    expect(tokenStep.question).toBeUndefined();

    const modeStep = await engine.handle("123:abc");
    expect(modeStep.text).toContain("1. Pairing");
    // The awaited select step is mirrored for card-capable clients; labels are
    // the replies parseWizardAnswer accepts.
    expect(modeStep.question).toEqual({
      id: expect.any(String),
      header: "Choose one",
      question: "DM mode",
      options: [{ label: "Pairing" }, { label: "Open" }],
    });

    const done = await engine.handle("Open");
    expect(done.text).toContain("telegram is configured");
    expect(done.question).toBeUndefined();
    expect(wizardRuns).toEqual(["telegram", "token:123:abc", "mode:open"]);
  });

  it("hosts the real skills setup flow and guards installs plus the final config write", async () => {
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { workspace: "/tmp/skills-workspace" } },
    };
    const beforeEffects: Array<() => Promise<void>> = [];
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "skills-base-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    mocks.setupSkills.mockImplementation(
      async (
        config: OpenClawConfig,
        workspaceDir: string,
        _runtime: unknown,
        prompter: WizardPrompter,
        options: { beforePersistentEffect?: () => Promise<void> },
      ) => {
        expect(workspaceDir).toBe("/tmp/skills-workspace");
        expect(options.beforePersistentEffect).toBeTypeOf("function");
        beforeEffects.push(options.beforePersistentEffect!);
        await prompter.note("Eligible: 2\nMissing requirements: 1", "Skills status");
        await options.beforePersistentEffect?.();
        return { ...config, skills: { install: { nodeManager: "npm" } } };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => config);
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      appendAuditEntry,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("configure skills");

    expect(reply.text).toContain("skills dependency setup is complete");
    expect(beforeEffects).toHaveLength(1);
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ skills: { install: { nodeManager: "npm" } } }),
      {
        allowConfigSizeDrop: false,
        baseHash: "skills-base-hash",
      },
    );
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "skills.setup" }),
    );
  });

  it("hosts search setup as question cards and keeps gateway credentials out of model history", async () => {
    const baseConfig: OpenClawConfig = {};
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    const beforePersistentEffects: Array<() => Promise<void>> = [];
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "search-base-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    mocks.runSearchSetupFlow.mockImplementation(
      async (
        config: OpenClawConfig,
        _runtime: unknown,
        prompter: WizardPrompter,
        options: {
          preserveDisabledSearchState?: boolean;
          beforePersistentEffect?: () => Promise<void>;
        },
      ) => {
        expect(options.preserveDisabledSearchState).toBe(false);
        beforePersistentEffects.push(options.beforePersistentEffect!);
        const provider = await prompter.select({
          message: "Search provider",
          options: [
            { value: "brave", label: "Brave" },
            { value: "grok", label: "Grok" },
          ],
          initialValue: "brave",
        });
        const key = await prompter.text({ message: "Provider API key", sensitive: true });
        expect(key).toBe("search-secret-value");
        await options.beforePersistentEffect?.();
        return {
          outcome: "completed",
          config: {
            ...config,
            tools: { web: { search: { enabled: true, provider } } },
          } as OpenClawConfig,
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => config);
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      appendAuditEntry,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const providerStep = await engine.handle("configure search");
    expect(providerStep.question).toEqual({
      id: expect.any(String),
      header: "Choose one",
      question: "Search provider",
      options: [{ label: "Brave", recommended: true }, { label: "Grok" }],
    });

    const secretStep = await engine.handle("Brave");
    expect(secretStep.text).toContain("Provider API key");
    expect(secretStep.sensitive).toBe(true);
    expect(secretStep.question).toBeUndefined();

    const done = await engine.handle("search-secret-value");
    expect(done.text).toContain("web search setup is complete");
    expect(beforePersistentEffects).toHaveLength(1);
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "search.setup" }),
    );
    expect(JSON.stringify(engine.historySince(0))).not.toContain("search-secret-value");
    expect(JSON.stringify(engine.historySince(0))).toContain("<redacted secret>");
  });

  it("hosts full Gateway setup with a lockout warning, audited config write, and no restart", async () => {
    const baseConfig: OpenClawConfig = {
      ...structuredClone(sharedVerifiedInferenceConfig),
      gateway: { mode: "local" },
    };
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "gateway-base-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => config);
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      appendAuditEntry,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const { portStep, tokenStep } = await advanceGatewayWizardToToken(engine);
    expect(portStep.text).toContain(
      "changing the Gateway port, bind address, or auth credential requires a Gateway restart",
    );
    expect(portStep.text).toContain(
      "sign in to the Control UI again with the new address or credential",
    );
    expect(portStep.text).toContain("Gateway port");

    expect(tokenStep.text).toContain("Gateway token");
    expect(tokenStep.sensitive).toBe(true);

    const done = await engine.handle("gateway-secret-value");

    expect(done.text).toContain("Done — gateway settings saved.");
    expect(done.text).toContain("Restart the Gateway to apply them (`restart gateway`).");
    expect(done.text).not.toContain("restarted");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({
          port: 19001,
          bind: "lan",
          auth: expect.objectContaining({ mode: "token", token: "gateway-secret-value" }),
          tailscale: expect.objectContaining({ mode: "off" }),
        }),
      }),
      {
        allowConfigSizeDrop: false,
        baseHash: "gateway-base-hash",
        afterWrite: {
          mode: "none",
          reason: "Gateway setup defers runtime apply until explicit restart",
        },
      },
    );
    expect(appendAuditEntry).toHaveBeenCalledWith({
      operation: "gateway.setup",
      summary: "Configured Gateway via chat setup",
      details: { capability: "gateway" },
    });
    expect(JSON.stringify(engine.historySince(0))).not.toContain("gateway-secret-value");
    expect(JSON.stringify(engine.historySince(0))).toContain("<redacted secret>");
  });

  it("rechecks inference authority immediately before a hosted Gateway write", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      ...structuredClone(sharedVerifiedInferenceConfig),
      gateway: { mode: "local" },
    };
    const currentConfig = structuredClone(baseConfig);
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "gateway-base-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => config);
    const changedConfig: OpenClawConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "changed-test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    };
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    // The route flips between the final turn's entry gate and the
    // persistent-apply recheck; only the apply boundary can catch it.
    let baseReadsRemaining = Number.POSITIVE_INFINITY;
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference,
      runAgentTurn: async () => null,
      deps: {
        loadOverview: fakeOverviewLoader(),
        readConfigFileSnapshot: vi.fn(async () => {
          const config = baseReadsRemaining > 0 ? currentConfig : changedConfig;
          baseReadsRemaining -= 1;
          return configSnapshot(config);
        }) as never,
      },
    });

    const { tokenStep } = await advanceGatewayWizardToToken(engine);
    expect(tokenStep.sensitive).toBe(true);
    baseReadsRemaining = 1;

    const stopped = await engine.handle("gateway-secret-value");

    expect(stopped.text).toContain("Gateway setup stopped");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
  });

  it("keeps remote Gateway mode guidance-only", async () => {
    const baseConfig: OpenClawConfig = { gateway: { mode: "remote" } };
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "remote-gateway-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("configure gateway");

    expect(reply.text).toContain("manages only a local Gateway");
    expect(reply.text).toContain("`openclaw onboard` for fresh setup");
    expect(reply.text).toContain("`openclaw configure` for the mode question");
    expect(reply.text).not.toContain("Gateway port");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
  });

  it("hands CLI Gateway credentials to the masked terminal wizard", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runGatewaySetupWizard: async (prompter) => {
        await prompter.text({ message: "Gateway token", sensitive: true });
      },
    });

    const stopped = await engine.handle("configure gateway");
    expect(stopped.text).toContain("Sensitive input is not accepted");
    expect(stopped.text).toContain("open gateway wizard");
    expect(stopped.text).toContain("openclaw configure --section gateway");
    expect(stopped.sensitive).toBeUndefined();

    const handoff = await engine.handle("open gateway wizard");
    expect(handoff.action).toBe("open-setup");
    expect(handoff.handoff).toEqual({ kind: "open-setup", target: "gateway" });
  });

  it("reports a failed hosted search-provider install without writing or auditing", async () => {
    const baseConfig: OpenClawConfig = {};
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "search-base-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    mocks.runSearchSetupFlow.mockResolvedValue({
      outcome: "install-failed",
      config: baseConfig,
      providerId: "brave",
      reason: "failed",
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      appendAuditEntry,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("configure search");

    expect(reply.text).toContain(
      "Web search setup stopped: Error: web search provider brave installation failed",
    );
    expect(reply.text).not.toContain("Done — web search setup is complete");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("hands CLI search credentials to the masked terminal wizard", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runSearchSetupWizard: async (prompter) => {
        await prompter.text({ message: "Provider API key", sensitive: true });
      },
    });

    const stopped = await engine.handle("configure search");
    expect(stopped.text).toContain("Sensitive input is not accepted");
    expect(stopped.text).toContain("open search wizard");
    expect(stopped.sensitive).toBeUndefined();

    const handoff = await engine.handle("open search wizard");
    expect(handoff.action).toBe("open-setup");
    expect(handoff.handoff).toEqual({ kind: "open-setup", target: "search" });
  });

  it("does not promise Doctor will repair every invalid channel setup config", async () => {
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      hash: "invalid-hash",
      config: {},
      sourceConfig: {},
      issues: [{ path: "gateway.port", message: "Expected number" }],
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("machine running OpenClaw");
    expect(reply.text).toContain("openclaw doctor --fix");
    expect(reply.text).toContain("remaining validation errors");
    expect(reply.text).not.toContain("repairs it");
  });

  it("reports hosted channel setup success when audit persistence fails", async () => {
    const appendAuditEntry = vi.fn(async () => {
      throw new Error("audit store is read-only");
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async () => {},
      appendAuditEntry,
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("Done — telegram is configured.");
    expect(reply.text).not.toContain("audit store is read-only");
    expect(appendAuditEntry).toHaveBeenCalledOnce();
  });

  it("rejects a hosted channel commit after a concurrent inference-route change", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: {
        profiles: { "openai:main": { provider: "openai", mode: "api_key" } },
      },
    };
    let currentConfig = structuredClone(baseConfig);
    let currentHash = "base-hash";
    mocks.readSetupConfigFileSnapshot.mockImplementation(async () => ({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: currentHash,
      config: structuredClone(currentConfig),
      sourceConfig: structuredClone(currentConfig),
      issues: [],
    }));
    mocks.setupChannels.mockImplementation(
      async (config: OpenClawConfig, _runtime: unknown, prompter: WizardPrompter) => {
        const token = await prompter.text({ message: "Bot token" });
        return {
          ...config,
          channels: {
            ...config.channels,
            telegram: { botToken: token },
          },
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(
      async (nextConfig: OpenClawConfig, opts: { baseHash?: string }) => {
        if (opts.baseHash !== currentHash) {
          throw new Error("configuration changed during channel setup");
        }
        currentConfig = structuredClone(nextConfig);
        currentHash = "committed-hash";
        return nextConfig;
      },
    );
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");

    const concurrentConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
      auth: {
        profiles: { "anthropic:main": { provider: "anthropic", mode: "api_key" } },
      },
    };
    currentConfig = structuredClone(concurrentConfig);
    currentHash = "concurrent-hash";

    const stopped = await engine.handle("123:abc");

    expect(stopped.text).toContain("Telegram setup stopped");
    expect(stopped.text).toContain("configuration changed during channel setup");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({ telegram: { botToken: "123:abc" } }),
      }),
      expect.objectContaining({
        baseHash: "base-hash",
      }),
    );
    expect(currentConfig).toEqual(concurrentConfig);
  });

  it("rechecks inference authority immediately before a hosted channel write", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: { profiles: { "openai:main": { provider: "openai", mode: "api_key" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    };
    const changedConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
    };
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = structuredClone(baseConfig);
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "base-hash",
      config: structuredClone(baseConfig),
      sourceConfig: structuredClone(baseConfig),
      issues: [],
    });
    mocks.setupChannels.mockImplementation(
      async (config: OpenClawConfig, _runtime: unknown, prompter: WizardPrompter) => {
        const token = await prompter.text({ message: "Bot token" });
        currentConfig = structuredClone(changedConfig);
        return {
          ...config,
          channels: { telegram: { botToken: token } },
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => config);
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference,
      runAgentTurn: async () => null,
      deps: {
        loadOverview: fakeOverviewLoader(),
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
      },
    });

    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");
    const stopped = await engine.handle("123:abc");

    expect(stopped.text).toContain("Telegram setup stopped");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
    expect(mocks.runCollectedChannelOnboardingPostWriteHooks).not.toHaveBeenCalled();
  });

  it("rechecks inference authority before hosted channel post-write hooks", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: { profiles: { "openai:main": { provider: "openai", mode: "api_key" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    };
    const changedConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
    };
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = structuredClone(baseConfig);
    const hook = { channel: "telegram", accountId: "default", run: vi.fn() };
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "base-hash",
      config: structuredClone(baseConfig),
      sourceConfig: structuredClone(baseConfig),
      issues: [],
    });
    mocks.setupChannels.mockImplementation(
      async (
        config: OpenClawConfig,
        _runtime: unknown,
        prompter: WizardPrompter,
        options: { onPostWriteHook?: (hook: unknown) => void },
      ) => {
        const token = await prompter.text({ message: "Bot token" });
        options.onPostWriteHook?.(hook);
        return {
          ...config,
          channels: { telegram: { botToken: token } },
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => {
      currentConfig = structuredClone(changedConfig);
      return config;
    });
    mocks.runCollectedChannelOnboardingPostWriteHooks.mockImplementationOnce(
      async (params?: { beforePersistentEffect?: () => Promise<void> }) => {
        await params?.beforePersistentEffect?.();
      },
    );
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference,
      runAgentTurn: async () => null,
      deps: {
        loadOverview: fakeOverviewLoader(),
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
      },
    });

    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");
    const stopped = await engine.handle("123:abc");

    expect(stopped.text).toContain("Telegram setup stopped");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledOnce();
    expect(hook.run).not.toHaveBeenCalled();
  });
});

describe("hosted channel post-write hooks", () => {
  it("runs collected channel hooks after writing config", async () => {
    const hook = { channel: "matrix", accountId: "default", run: vi.fn() };
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "hook-base-hash",
      config: {},
      sourceConfig: {},
    });
    mocks.setupChannels.mockImplementation(
      async (
        _config: OpenClawConfig,
        _runtime: unknown,
        _prompter: WizardPrompter,
        options: { onPostWriteHook?: (value: typeof hook) => void },
      ) => {
        options.onPostWriteHook?.(hook);
        return { channels: { matrix: { enabled: true } } };
      },
    );
    const committed = { channels: { matrix: { enabled: true, committed: true } } };
    mocks.writeWizardConfigFile.mockResolvedValue(committed);
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect matrix");

    expect(reply.text).toContain("matrix is configured");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      { channels: { matrix: { enabled: true } } },
      { allowConfigSizeDrop: false, baseHash: "hook-base-hash" },
    );
    expect(hook.run).toHaveBeenCalledWith({
      cfg: committed,
      runtime: expect.any(Object),
    });
    expect(mocks.writeWizardConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      hook.run.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
