import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { channelsStatusCommand } from "./channels/status.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  requireValidConfigSnapshot: vi.fn(),
  listChannelPlugins: vi.fn(),
  listConfiguredChannelIdsForReadOnlyScope: vi.fn((_params: unknown) => ["discord"]),
  missingOfficialExternalChannels: new Set<string>(),
  withProgress: vi.fn(async (_opts: unknown, run: () => Promise<unknown>) => await run()),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.callGateway(opts),
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: async (opts: {
    runtime?: { log: (message: string) => void };
  }) => {
    const result = await mocks.resolveCommandConfigWithSecrets(opts);
    for (const entry of result?.diagnostics ?? []) {
      opts.runtime?.log(`[secrets] ${entry}`);
    }
    return result;
  },
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: () => mocks.readConfigFileSnapshot(),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: (config: { channels?: Record<string, unknown> }) =>
    Object.keys(config.channels ?? {}),
  listConfiguredChannelIdsForReadOnlyScope: (params: unknown) =>
    mocks.listConfiguredChannelIdsForReadOnlyScope(params),
}));

vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint: ({ channelId }: { channelId: string }) =>
    mocks.missingOfficialExternalChannels.has(channelId)
      ? {
          pluginId: channelId,
          channelId,
          label: "Feishu",
          installSpec: "@openclaw/feishu",
          installCommand: "openclaw plugins install @openclaw/feishu",
          doctorFixCommand: "openclaw doctor --fix",
          repairHint:
            "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
        }
      : null,
}));

vi.mock("./channels/shared.js", () => ({
  requireValidConfigSnapshot: (runtime: unknown) => mocks.requireValidConfigSnapshot(runtime),
  formatChannelAccountLabel: ({
    channel,
    accountId,
  }: {
    channel: string;
    accountId: string;
    name?: string;
  }) => `${channel} ${accountId}`,
  appendEnabledConfiguredLinkedBits: (bits: string[], account: Record<string, unknown>) => {
    if (typeof account.enabled === "boolean") {
      bits.push(account.enabled ? "enabled" : "disabled");
    }
    if (account.configured === true) {
      bits.push("configured");
      if (Object.values(account).includes("configured_unavailable")) {
        bits.push("secret unavailable in this command path");
      }
    }
  },
  appendModeBit: (bits: string[], account: Record<string, unknown>) => {
    if (typeof account.mode === "string" && account.mode.length > 0) {
      bits.push(`mode:${account.mode}`);
    }
  },
  appendTokenSourceBits: (bits: string[], account: Record<string, unknown>) => {
    if (account.tokenSource === "config") {
      const unavailable = account.tokenStatus === "configured_unavailable" ? " (unavailable)" : "";
      bits.push(`token:config${unavailable}`);
    }
  },
  appendBaseUrlBit: (bits: string[], account: Record<string, unknown>) => {
    if (typeof account.baseUrl === "string" && account.baseUrl) {
      bits.push(`url:${account.baseUrl}`);
    }
  },
  buildChannelAccountLine: (channel: string, account: Record<string, unknown>, bits: string[]) => {
    const accountId = typeof account.accountId === "string" ? account.accountId : "default";
    return `- ${channel} ${accountId}: ${bits.join(", ")}`;
  },
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => mocks.listChannelPlugins(),
  getChannelPlugin: (channel: string) =>
    (mocks.listChannelPlugins() as Array<{ id: string }>).find((plugin) => plugin.id === channel),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => mocks.listChannelPlugins(),
}));

vi.mock("../channels/account-snapshot-fields.js", () => ({
  hasConfiguredUnavailableCredentialStatus: (account: Record<string, unknown>) =>
    Object.values(account).includes("configured_unavailable"),
  hasResolvedCredentialValue: (account: Record<string, unknown>) =>
    ["token", "botToken", "appToken", "signingSecret"].some(
      (key) => typeof account[key] === "string" && account[key].length > 0,
    ),
}));

vi.mock("../channels/plugins/status.js", () => ({
  buildReadOnlySourceChannelAccountSnapshot: async ({
    plugin,
    cfg,
    accountId,
  }: {
    plugin: ReturnType<typeof createTokenOnlyPlugin>;
    cfg: { secretResolved?: boolean };
    accountId: string;
  }) => ({
    accountId,
    ...plugin.config.inspectAccount(cfg),
  }),
  buildChannelAccountSnapshot: async ({
    plugin,
    cfg,
    accountId,
  }: {
    plugin: ReturnType<typeof createTokenOnlyPlugin>;
    cfg: { secretResolved?: boolean };
    accountId: string;
  }) => ({
    accountId,
    ...plugin.config.resolveAccount(cfg),
  }),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getConfiguredChannelsCommandSecretTargetIds: () => [],
}));

vi.mock("../infra/channels-status-issues.js", () => ({
  collectChannelStatusIssues: () => [],
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: (opts: unknown, run: () => Promise<unknown>) => mocks.withProgress(opts, run),
}));

function createTokenAccountSnapshot(cfg: { secretResolved?: boolean }) {
  return {
    name: "Primary",
    enabled: true,
    configured: true,
    token: cfg.secretResolved ? "resolved-discord-token" : "",
    tokenSource: "config",
    tokenStatus: cfg.secretResolved ? "available" : "configured_unavailable",
  };
}

function createTokenOnlyPlugin() {
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: resolveDefaultAccountId,
      inspectAccount: createTokenAccountSnapshot,
      resolveAccount: createTokenAccountSnapshot,
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
  };
}

describe("channelsStatusCommand SecretRef fallback flow", () => {
  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockReset();
    mocks.readConfigFileSnapshot.mockClear();
    mocks.requireValidConfigSnapshot.mockReset();
    mocks.listChannelPlugins.mockReset();
    mocks.missingOfficialExternalChannels.clear();
    mocks.listConfiguredChannelIdsForReadOnlyScope.mockClear();
    mocks.listConfiguredChannelIdsForReadOnlyScope.mockReturnValue(["discord"]);
    mocks.withProgress.mockClear();
    mocks.listChannelPlugins.mockReturnValue([createTokenOnlyPlugin()]);
  });

  it("keeps read-only fallback output when SecretRefs are unresolved", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
    mocks.requireValidConfigSnapshot.mockResolvedValue({ secretResolved: false, channels: {} });
    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      resolvedConfig: { secretResolved: false, channels: {} },
      effectiveConfig: { secretResolved: false, channels: {} },
      diagnostics: [
        "channels status: channels.discord.token is unavailable in this command path; continuing with degraded read-only config.",
      ],
    });
    const { runtime, logs, errors } = createCapturingTestRuntime();

    await channelsStatusCommand({ probe: false }, runtime as never);

    expect(errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Gateway not reachable")]),
    );
    expect(mocks.resolveCommandConfigWithSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "channels status",
        mode: "read_only_status",
      }),
    );
    expect(
      logs.some((line) =>
        line.includes("[secrets] channels status: channels.discord.token is unavailable"),
      ),
    ).toBe(true);
    const joined = logs.join("\n");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });

  it("prefers resolved snapshots when command-local SecretRef resolution succeeds", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
    mocks.requireValidConfigSnapshot.mockResolvedValue({ secretResolved: false, channels: {} });
    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      resolvedConfig: { secretResolved: true, channels: {} },
      effectiveConfig: { secretResolved: true, channels: {} },
      diagnostics: [],
    });
    const { runtime, logs } = createCapturingTestRuntime();

    await channelsStatusCommand({ probe: false }, runtime as never);

    const joined = logs.join("\n");
    expect(joined).toContain("configured");
    expect(joined).toContain("token:config");
    expect(joined).not.toContain("secret unavailable in this command path");
    expect(joined).not.toContain("token:config (unavailable)");
  });

  it("shows missing official external plugin repair hints in config-only output", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
    mocks.requireValidConfigSnapshot.mockResolvedValue({
      channels: { feishu: { appId: "cli_xxx" } },
    });
    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      resolvedConfig: { channels: { feishu: { appId: "cli_xxx" } } },
      effectiveConfig: { channels: { feishu: { appId: "cli_xxx" } } },
      diagnostics: [],
    });
    mocks.missingOfficialExternalChannels.add("feishu");
    mocks.listChannelPlugins.mockReturnValue([]);
    const { runtime, logs } = createCapturingTestRuntime();

    await channelsStatusCommand({ probe: false }, runtime as never);

    const joined = logs.join("\n");
    expect(joined).toContain("Missing official external plugins:");
    expect(joined).toContain(
      "Feishu: Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    );
  });

  it("keeps JSON fallback structured without rendering config-only text", async () => {
    mocks.callGateway.mockRejectedValue(
      new Error(
        [
          "gateway timeout after 3000ms",
          "Gateway target: wss://user:pass@gateway.example.com/socket?token=secret-token&keep=visible",
          "Gateway fallback: (wss://fallback-user:fallback-pass@[bad-host/socket?token=fallback-secret&keep=visible)",
          "Source: env OPENCLAW_GATEWAY_URL",
        ].join("\n"),
      ),
    );
    mocks.requireValidConfigSnapshot.mockResolvedValue({ secretResolved: false, channels: {} });
    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      resolvedConfig: { secretResolved: true, channels: {} },
      effectiveConfig: { secretResolved: true, channels: {} },
      diagnostics: [],
    });
    const { runtime, logs, errors } = createCapturingTestRuntime();

    await channelsStatusCommand({ json: true, probe: false }, runtime as never);

    expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
    expect(mocks.listConfiguredChannelIdsForReadOnlyScope).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ secretResolved: true }),
        includePersistedAuthState: false,
      }),
    );
    const payload = JSON.parse(logs.at(-1) ?? "{}");
    expect(errors.join("\n")).not.toContain("user:pass");
    expect(errors.join("\n")).not.toContain("secret-token");
    expect(errors.join("\n")).not.toContain("fallback-user:fallback-pass");
    expect(errors.join("\n")).not.toContain("fallback-secret");
    expect(payload.error).toContain("Gateway target:");
    expect(payload.error).not.toContain("user:pass");
    expect(payload.error).not.toContain("secret-token");
    expect(payload.error).not.toContain("fallback-user:fallback-pass");
    expect(payload.error).not.toContain("fallback-secret");
    expect(payload).toEqual(
      expect.objectContaining({
        gatewayReachable: false,
        configOnly: true,
        configuredChannels: ["discord"],
      }),
    );
  });
});
