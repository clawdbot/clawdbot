// Configure wizard Gateway tests cover run-mode probes, auth routing, and cancellation.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createWizardTestRuntime,
  queueWizardTestPrompts,
  setupBaseWizardTestState,
} from "./configure.wizard-test-helpers.js";

const mocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn();
  return {
    clackIntro: vi.fn(),
    clackOutro: vi.fn(),
    clackSelect: vi.fn(),
    clackText: vi.fn(),
    clackConfirm: vi.fn(),
    clackPassword: vi.fn(),
    resolveSearchProviderOptions: vi.fn(),
    resolvePluginContributionOwners: vi.fn(),
    setupSearch: vi.fn(),
    assertConfigPathForWrite: vi.fn(),
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile,
    replaceConfigFile: vi.fn(
      async (params: {
        nextConfig: unknown;
        writeOptions?: { assertConfigPathForWrite?: () => void };
      }) => {
        params.writeOptions?.assertConfigPathForWrite?.();
        await writeConfigFile(params.nextConfig);
      },
    ),
    resolveGatewayPort: vi.fn(),
    createClackPrompter: vi.fn(),
    note: vi.fn(),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(),
    waitForGatewayReachable: vi.fn(async () => ({ ok: true })),
    resolveAdvertisedControlUiLinks: vi.fn(),
    resolveControlUiLinks: vi.fn(),
    resolveLocalControlUiProbeLinks: vi.fn(),
    inspectWindowsGatewayFirewall: vi.fn(),
    summarizeExistingConfig: vi.fn(),
    healthCommand: vi.fn(),
    promptAuthConfig: vi.fn(),
    promptGatewayConfig: vi.fn(),
    promptRemoteGatewayConfig: vi.fn(
      async (cfg: OpenClawConfig): Promise<OpenClawConfig> => ({
        ...cfg,
        gateway: { mode: "remote", remote: { url: "wss://gateway.example.test" } },
      }),
    ),
    isCodexNativeWebSearchRelevant: vi.fn(({ config }: { config: OpenClawConfig }) =>
      Boolean(config.auth?.profiles?.["openai:default"]),
    ),
    setupChannels: vi.fn(async (cfg: OpenClawConfig) => cfg),
    guardCancel: vi.fn((value: unknown, _runtime: RuntimeEnv, _exitCode?: number) => value),
  };
});

vi.mock("@clack/prompts", () => ({
  intro: mocks.clackIntro,
  outro: mocks.clackOutro,
  select: mocks.clackSelect,
  text: mocks.clackText,
  confirm: mocks.clackConfirm,
  password: mocks.clackPassword,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "~/.openclaw/openclaw.json",
  createConfigIO: () => ({
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: await mocks.readConfigFileSnapshot(),
      writeOptions: {
        assertConfigPathForWrite: mocks.assertConfigPathForWrite,
        expectedConfigPath: "/tmp/openclaw.json",
        ownedConfigPathForWrite: "/tmp/openclaw.json",
      },
    }),
  }),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await mocks.readConfigFileSnapshot(),
    writeOptions: {
      assertConfigPathForWrite: mocks.assertConfigPathForWrite,
      envSnapshotForRestore: { SECRET: "resolved-secret" },
      expectedConfigPath: "/tmp/openclaw.json",
      includeFileHashesForWrite: { "/tmp/plugins.json5": "stale-hash" },
      ownedConfigPathForWrite: "/tmp/openclaw.json",
    },
  }),
  resolveConfigWriteAfterWrite: (afterWrite?: { mode: string }) => afterWrite ?? { mode: "auto" },
  transformConfigFileWithRetry: async (
    params: Parameters<typeof import("../config/config.js").transformConfigFileWithRetry>[0],
  ) => {
    const maxAttempts = params.maxAttempts ?? 5;
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = await mocks.readConfigFileSnapshot();
      const previousHash = snapshot.hash ?? null;
      const config =
        params.base === "runtime"
          ? (snapshot.runtimeConfig ?? snapshot.config)
          : (snapshot.sourceConfig ?? snapshot.config);
      try {
        const transformed = await params.transform(config, { snapshot, previousHash, attempt });
        const committed = await params.commit!({
          nextConfig: transformed.nextConfig,
          snapshot,
          ...(previousHash ? { baseHash: previousHash } : {}),
          writeOptions: params.writeOptions,
          afterWrite: { mode: "auto" },
        });
        return { nextConfig: committed.config };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConfigMutationConflictError" ||
          (error as { retryable?: boolean }).retryable === false ||
          attempt === maxAttempts - 1
        ) {
          throw error;
        }
      }
    }
  },
  writeConfigFile: mocks.writeConfigFile,
  replaceConfigFile: mocks.replaceConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall: mocks.inspectWindowsGatewayFirewall,
  formatWindowsGatewayFirewallGuidance: (params: { bind?: string }) =>
    params.bind === "lan"
      ? [
          "Windows firewall: if another device cannot connect to the LAN URL, run `openclaw gateway status --deep` from this Windows host.",
        ]
      : [],
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
  ensureWorkspaceAndSessions: vi.fn(),
  guardCancel: mocks.guardCancel,
  printWizardHeader: mocks.printWizardHeader,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveAdvertisedControlUiLinks: mocks.resolveAdvertisedControlUiLinks,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  resolveLocalControlUiProbeLinks: mocks.resolveLocalControlUiProbeLinks,
  summarizeExistingConfig: mocks.summarizeExistingConfig,
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("./health.js", () => ({
  healthCommand: mocks.healthCommand,
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(),
}));

vi.mock("./configure.gateway.js", () => ({
  promptGatewayConfig: mocks.promptGatewayConfig,
}));

vi.mock("./configure.gateway-auth.js", () => ({
  promptAuthConfig: mocks.promptAuthConfig,
}));

vi.mock("./configure.channels.js", () => ({
  removeChannelConfigWizard: vi.fn(),
}));

vi.mock("./configure.daemon.js", () => ({
  maybeInstallDaemon: vi.fn(),
}));

vi.mock("./onboard-remote.js", () => ({
  promptRemoteGatewayConfig: mocks.promptRemoteGatewayConfig,
}));

vi.mock("./onboard-skills.js", () => ({
  setupSkills: vi.fn(),
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: mocks.setupChannels,
}));

vi.mock("../flows/search-setup.js", () => ({
  resolveSearchProviderOptions: mocks.resolveSearchProviderOptions,
  runSearchSetupFlow: mocks.setupSearch,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  resolvePluginContributionOwners: mocks.resolvePluginContributionOwners,
}));

vi.mock("../agents/codex-native-web-search.js", () => ({
  isCodexNativeWebSearchRelevant: mocks.isCodexNativeWebSearchRelevant,
}));

vi.mock("../config/mutate.js", async () => {
  const actual = await vi.importActual<typeof import("../config/mutate.js")>("../config/mutate.js");
  return {
    ...actual,
    ConfigMutationConflictError: actual.ConfigMutationConflictError,
  };
});

import { WizardCancelledError } from "../wizard/prompts.js";
import { maybeInstallDaemon } from "./configure.daemon.js";
import { runConfigureWizard } from "./configure.wizard.js";

const createRuntime = createWizardTestRuntime;

function setupBaseWizardState(config: OpenClawConfig = {}) {
  setupBaseWizardTestState(mocks, config);
}

const requireRecord = createRequireRecord("object", "expected-label");

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  label: string,
  callIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  return call[0];
}

function requireWriteConfig(callIndex = 0) {
  return requireRecord(
    mockCallArg(mocks.writeConfigFile, "writeConfigFile", callIndex),
    "written config",
  );
}

function getGateway(config: Record<string, unknown>) {
  return requireRecord(config.gateway, "gateway config");
}

function queueWizardPrompts(params: { select: string[]; confirm: boolean[]; text?: string }) {
  queueWizardTestPrompts(mocks, params);
}

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healthCommand.mockReset();
    mocks.assertConfigPathForWrite.mockImplementation(() => {});
    mocks.resolvePluginContributionOwners.mockReturnValue(["firecrawl"]);
    mocks.resolveSearchProviderOptions.mockReturnValue([
      {
        id: "firecrawl",
        label: "Firecrawl Search",
        hint: "Structured results with optional result scraping",
        credentialLabel: "Firecrawl API key",
        envVars: ["FIRECRAWL_API_KEY"],
        placeholder: "fc-...",
        signupUrl: "https://www.firecrawl.dev/",
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      },
    ]);
    mocks.setupSearch.mockReset();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => ({
      outcome: "completed",
      config: cfg,
    }));
    mocks.promptAuthConfig.mockReset();
    mocks.promptAuthConfig.mockImplementation(async (cfg: OpenClawConfig) => cfg);
    mocks.promptGatewayConfig.mockReset();
    mocks.promptGatewayConfig.mockImplementation(async (cfg: OpenClawConfig) => ({
      config: cfg,
      port: 18789,
    }));
    mocks.guardCancel.mockReset();
    mocks.guardCancel.mockImplementation((value: unknown) => value);
  });

  it("runs selected sections in canonical order and commits their combined config once", async () => {
    setupBaseWizardState();
    queueWizardPrompts({ select: ["local", "configure"], confirm: [] });
    const events: string[] = [];
    mocks.promptAuthConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("model");
      return cfg;
    });
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("gateway");
      return { config: cfg, port: 18789 };
    });
    mocks.setupChannels.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("channels");
      return cfg;
    });
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      events.push("commit");
    });

    await runConfigureWizard(
      { command: "configure", sections: ["channels", "gateway", "model"] },
      createRuntime(),
    );

    expect(events).toEqual(["model", "gateway", "channels", "commit"]);
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  });

  it("commits every interactive section before running the next section", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["local", "model", "gateway", "channels", "configure", "__continue"],
      confirm: [],
    });
    const events: string[] = [];
    mocks.promptAuthConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("model");
      return cfg;
    });
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("gateway");
      return { config: cfg, port: 18789 };
    });
    mocks.setupChannels.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("channels");
      return cfg;
    });
    for (let index = 0; index < 3; index += 1) {
      mocks.writeConfigFile.mockImplementationOnce(async () => {
        events.push("commit");
      });
    }

    await runConfigureWizard({ command: "configure" }, createRuntime());

    expect(events).toEqual(["model", "commit", "gateway", "commit", "channels", "commit"]);
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(3);
  });

  it("commits selected gateway config before installing its configured daemon port", async () => {
    setupBaseWizardState();
    queueWizardPrompts({ select: ["local"], confirm: [] });
    const events: string[] = [];
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("gateway");
      return { config: cfg, port: 18991 };
    });
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      events.push("commit");
    });
    vi.mocked(maybeInstallDaemon).mockImplementationOnce(async () => {
      events.push("daemon");
      return "succeeded";
    });

    await runConfigureWizard(
      { command: "configure", sections: ["daemon", "gateway"] },
      createRuntime(),
    );

    expect(events).toEqual(["gateway", "commit", "daemon"]);
    expect(maybeInstallDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 18991 }));
    expect(mocks.clackText).not.toHaveBeenCalled();
  });

  it("keeps remote password health when the configured token ref is unresolved", async () => {
    const remotePassword = "remote-password"; // pragma: allowlist secret
    const remoteConfig: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example.test",
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          password: remotePassword,
        },
      },
      secrets: { providers: { default: { source: "env" } } },
    };
    setupBaseWizardState(remoteConfig);
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.promptRemoteGatewayConfig.mockResolvedValueOnce(remoteConfig);

    await runConfigureWizard({ command: "configure", sections: ["health"] }, createRuntime());

    expect(mocks.healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        config: remoteConfig,
        token: undefined,
        password: remotePassword,
        ignoreEnvUrlOverride: true,
      }),
      expect.anything(),
    );
  });

  it.each([false, true])("reports failed remote health checks (reachable: %s)", async (probeOk) => {
    setupBaseWizardState();
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.waitForGatewayReachable.mockResolvedValueOnce({ ok: probeOk });
    mocks.healthCommand.mockRejectedValueOnce(new Error("health request failed"));

    await runConfigureWizard({ command: "configure", sections: ["health"] }, createRuntime());

    expect(mocks.clackOutro).toHaveBeenCalledWith(expect.stringContaining("health check failed"));
  });

  it("skips remote health when a configured SecretRef is unresolved", async () => {
    const unresolvedConfig: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example.test",
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
        },
      },
      secrets: { providers: { default: { source: "env" } } },
    };
    setupBaseWizardState(unresolvedConfig);
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.promptRemoteGatewayConfig.mockResolvedValueOnce(unresolvedConfig);
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }, async () => {
      await runConfigureWizard({ command: "configure", sections: ["health"] }, createRuntime());
    });

    const authNote = mocks.note.mock.calls.find(([, title]) => title === "Gateway auth")?.[0];
    expect(authNote).toContain("Health check skipped");
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(mocks.clackOutro).toHaveBeenCalledWith(
      "Remote gateway configured; health check skipped.",
    );
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["local", "__continue"],
      confirm: [false],
    });

    await runConfigureWizard({ command: "configure" }, createRuntime());

    expect(getGateway(requireWriteConfig()).mode).toBe("local");
    const replaceParams = requireRecord(
      mockCallArg(mocks.replaceConfigFile, "replaceConfigFile"),
      "replace config params",
    );
    const writeOptions = requireRecord(replaceParams.writeOptions, "write options");
    expect(Object.keys(writeOptions).toSorted()).toEqual([
      "assertConfigPathForWrite",
      "expectedConfigPath",
      "ownedConfigPathForWrite",
    ]);
  });
  it("keeps startup gateway hint probes bounded", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        remote: {
          url: "wss://gateway.example.test",
          token: "token",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    });
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "env-password" }, async () => {
      await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());
    });

    const probeRequests = mocks.probeGatewayReachable.mock.calls.map(([request]) =>
      requireRecord(request, "probe request"),
    );
    const localProbe = probeRequests.find((request) => request.url === "ws://127.0.0.1:18789");
    const remoteProbe = probeRequests.find(
      (request) => request.url === "wss://gateway.example.test",
    );
    expect(localProbe?.timeoutMs).toBe(300);
    expect(remoteProbe).toEqual({
      url: "wss://gateway.example.test",
      config: expect.objectContaining({
        gateway: expect.objectContaining({
          remote: expect.objectContaining({
            edgeAuth: { "X-Edge-Auth": "test-secret" },
          }),
        }),
      }),
      token: "token",
      timeoutMs: 300,
    });
  });

  it("ignores blank gateway env credentials when probing the local gateway", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        auth: { token: "configured-token", password: "configured-password" },
      },
    });
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    try {
      await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());
    } finally {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    }

    const probeRequests = mocks.probeGatewayReachable.mock.calls.map(([request]) =>
      requireRecord(request, "probe request"),
    );
    const localProbe = probeRequests.find((request) => request.url === "ws://127.0.0.1:18789");
    expect(localProbe?.token).toBe("configured-token");
    expect(localProbe?.password).toBe("configured-password");
  });

  it("uses the resolved configured port for the local gateway startup hint", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        port: 18991,
      },
    });
    mocks.resolveGatewayPort.mockReturnValue(18991);
    mocks.probeGatewayReachable
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: false });
    mocks.clackSelect.mockResolvedValue("local");

    await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());

    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18991", timeoutMs: 300 }),
    );
    expect(mocks.clackSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Where will the Gateway run?",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "local",
            hint: "Gateway reachable (ws://127.0.0.1:18991)",
          }),
        ]),
      }),
    );
  });

  it("advertises LAN Control UI links while probing the local gateway", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "token" },
      },
    });
    mocks.resolveAdvertisedControlUiLinks.mockResolvedValueOnce({
      httpUrl: "http://10.211.55.3:18789/",
      wsUrl: "ws://10.211.55.3:18789",
    });
    mocks.resolveLocalControlUiProbeLinks.mockReturnValueOnce({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    });
    await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());

    expect(mocks.resolveAdvertisedControlUiLinks).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "lan", port: 18789 }),
    );
    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Web UI: http://10.211.55.3:18789/"),
      "Control UI",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway WS: ws://10.211.55.3:18789"),
      "Control UI",
    );
  });

  it("shows static Windows Firewall guidance for LAN Gateway links without inspection", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "token" },
      },
    });

    await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());

    expect(mocks.inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Windows firewall: if another device cannot connect to the LAN URL"),
      "Control UI",
    );
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("uses nonzero exit semantics for cancellation at the first direct Clack prompt", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.guardCancel.mockImplementationOnce(
      (_value: unknown, promptRuntime: RuntimeEnv, exitCode?: number) => {
        promptRuntime.exit(exitCode ?? 0);
        throw new Error("direct prompt cancelled");
      },
    );

    await expect(runConfigureWizard({ command: "configure" }, runtime)).rejects.toThrow(
      "direct prompt cancelled",
    );

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not gate model-only configure behind Gateway run-mode selection", async () => {
    setupBaseWizardState();

    await runConfigureWizard({ command: "configure", sections: ["model"] }, createRuntime());

    expect(mocks.promptAuthConfig).toHaveBeenCalledOnce();
    expect(mocks.clackSelect).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Where will the Gateway run?" }),
    );
    expect(mocks.probeGatewayReachable).not.toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300 }),
    );
    expect(mocks.resolveControlUiLinks).not.toHaveBeenCalled();
    expect(requireWriteConfig().gateway).toBeUndefined();
  });

  it("runs model-only configure for existing remote Gateway configs", async () => {
    setupBaseWizardState({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example.test" } },
    });

    await runConfigureWizard({ command: "configure", sections: ["model"] }, createRuntime());

    expect(mocks.promptAuthConfig).toHaveBeenCalledOnce();
    expect(mocks.promptRemoteGatewayConfig).not.toHaveBeenCalled();
    expect(getGateway(requireWriteConfig()).mode).toBe("remote");
    expect(mocks.resolveControlUiLinks).not.toHaveBeenCalled();
    expect(mocks.probeGatewayReachable).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      [
        "Remote Gateway:",
        "wss://gateway.example.test",
        "Docs: https://docs.openclaw.ai/gateway/remote",
      ].join("\n"),
      "Gateway",
    );
  });
});
