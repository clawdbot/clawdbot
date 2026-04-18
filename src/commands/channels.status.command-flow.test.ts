import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { channelsStatusCommand } from "./channels/status.js";

const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  requireValidConfigSnapshot: vi.fn(),
  listChannelPlugins: vi.fn(),
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
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => mocks.listChannelPlugins(),
  getChannelPlugin: (channel: string) =>
    (mocks.listChannelPlugins() as Array<{ id: string }>).find((plugin) => plugin.id === channel),
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
  getChannelsCommandSecretTargetIds: () => [],
}));

vi.mock("../infra/channels-status-issues.js", () => ({
  collectChannelStatusIssues: () => [],
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: (opts: unknown, run: () => Promise<unknown>) => mocks.withProgress(opts, run),
}));

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
      inspectAccount: (cfg: { secretResolved?: boolean }) =>
        cfg.secretResolved
          ? {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "resolved-discord-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            },
      resolveAccount: (cfg: { secretResolved?: boolean }) =>
        cfg.secretResolved
          ? {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "resolved-discord-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            },
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
  };
}

function createRuntimeCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (message: unknown) => logs.push(String(message)),
    error: (message: unknown) => errors.push(String(message)),
    exit: (_code?: number) => undefined,
  };
  return { runtime, logs, errors };
}

describe("channelsStatusCommand SecretRef fallback flow", () => {
  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockReset();
    mocks.readConfigFileSnapshot.mockClear();
    mocks.requireValidConfigSnapshot.mockReset();
    mocks.listChannelPlugins.mockReset();
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
    const { runtime, logs, errors } = createRuntimeCapture();

    await channelsStatusCommand({ probe: false }, runtime as never);

    expect(errors.some((line) => line.includes("Gateway not reachable"))).toBe(true);
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
    const { runtime, logs } = createRuntimeCapture();

    await channelsStatusCommand({ probe: false }, runtime as never);

    const joined = logs.join("\n");
    expect(joined).toContain("configured");
    expect(joined).toContain("token:config");
    expect(joined).not.toContain("secret unavailable in this command path");
    expect(joined).not.toContain("token:config (unavailable)");
  });
});
