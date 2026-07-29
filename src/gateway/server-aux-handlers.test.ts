// Gateway auxiliary handler tests cover hot config reload behavior, prepared
// secret snapshot updates, and restart-plan side effects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { enforceSharedGatewaySessionGenerationForConfigWrite } from "./server-shared-auth-generation.js";

function publishSharedGatewayGeneration(
  state: { current: string | undefined; required: string | undefined | null },
  generation: string,
) {
  enforceSharedGatewaySessionGenerationForConfigWrite({
    state,
    nextConfig: { gateway: { reload: { mode: "off" } } },
    resolveRuntimeSnapshotGeneration: () => generation,
    clients: [],
  });
}

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function createReloadPlan(overrides?: Partial<GatewayReloadPlan>): GatewayReloadPlan {
  return {
    changedPaths: overrides?.changedPaths ?? [],
    restartGateway: overrides?.restartGateway ?? false,
    restartReasons: overrides?.restartReasons ?? [],
    hotReasons: overrides?.hotReasons ?? [],
    reloadHooks: overrides?.reloadHooks ?? false,
    restartGmailWatcher: overrides?.restartGmailWatcher ?? false,
    restartCron: overrides?.restartCron ?? false,
    restartHeartbeat: overrides?.restartHeartbeat ?? false,
    restartHealthMonitor: overrides?.restartHealthMonitor ?? false,
    reloadPlugins: overrides?.reloadPlugins ?? false,
    restartChannels: overrides?.restartChannels ?? new Set(),
    restartChannelAccounts: overrides?.restartChannelAccounts,
    disposeMcpRuntimes: overrides?.disposeMcpRuntimes ?? false,
    noopPaths: overrides?.noopPaths ?? [],
  };
}

function createSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: asConfig({}),
    config,
    authStores: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  };
}

function createSourceSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return { ...createSnapshot(config), sourceConfig: config };
}

function slackConfig(signingSecret: string) {
  return asConfig({
    channels: { slack: { signingSecret } },
  });
}

function slackZaloConfig(slackSigningSecret: string, zaloWebhookSecret: string) {
  return asConfig({
    channels: {
      slack: { signingSecret: slackSigningSecret },
      zalo: { webhookSecret: zaloWebhookSecret },
    },
  });
}

function slackZaloDiscordConfig(
  slackSigningSecret: string,
  zaloWebhookSecret: string,
  discordToken: string,
) {
  return asConfig({
    channels: {
      slack: { signingSecret: slackSigningSecret },
      zalo: { webhookSecret: zaloWebhookSecret },
      discord: { token: discordToken },
    },
  });
}

function gatewayTokenSlackConfig(token: string, signingSecret: string) {
  return asConfig({
    gateway: {
      auth: { mode: "token", token },
    },
    channels: {
      slack: { signingSecret },
    },
  });
}

function activateSnapshot(config: OpenClawConfig) {
  activateSecretsRuntimeSnapshot(createSnapshot(config));
}

function mockResolvedSecrets(config: OpenClawConfig) {
  return vi.fn().mockResolvedValue(createSnapshot(config));
}

async function invokeSecretsReload(params: {
  handlers: ReturnType<typeof createGatewayAuxHandlers>["extraHandlers"];
  respond: ReturnType<typeof vi.fn>;
}) {
  await params.handlers["secrets.reload"]({
    req: { type: "req", id: "1", method: "secrets.reload" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as Parameters<
      ReturnType<typeof createGatewayAuxHandlers>["extraHandlers"]["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

type RespondCall = [boolean, unknown, { message?: string } | undefined];
type GatewayAuxHandlerParams = Parameters<typeof createGatewayAuxHandlers>[0];
type ChannelName = Parameters<GatewayAuxHandlerParams["startChannel"]>[0];

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const call = respond.mock.calls[0];
  if (!call) {
    throw new Error("expected respond call");
  }
  return call as RespondCall;
}

function buildRestartChannelsPlan(...channels: ChannelName[]) {
  return () =>
    createReloadPlan({
      restartChannels: new Set(channels),
    });
}

type SecretsReloadHarnessParams = {
  activateRuntimeSecrets: GatewayAuxHandlerParams["activateRuntimeSecrets"];
  buildReloadPlan?: GatewayAuxHandlerParams["buildReloadPlan"];
  sharedGatewaySessionGenerationState?: GatewayAuxHandlerParams["sharedGatewaySessionGenerationState"];
  resolveSharedGatewaySessionGenerationForConfig?: GatewayAuxHandlerParams["resolveSharedGatewaySessionGenerationForConfig"];
  clients?: GatewayAuxHandlerParams["clients"];
  startChannel?: GatewayAuxHandlerParams["startChannel"];
  stopChannel?: GatewayAuxHandlerParams["stopChannel"];
  getChannelAutostartSuppression?: GatewayAuxHandlerParams["getChannelAutostartSuppression"];
  logChannelsInfo?: GatewayAuxHandlerParams["logChannels"]["info"];
  respond?: ReturnType<typeof vi.fn>;
};

function createSecretsReloadHarness(params: SecretsReloadHarnessParams) {
  const respond = params.respond ?? vi.fn();
  const gatewayAux = createGatewayAuxHandlers({
    log: {},
    activateRuntimeSecrets: params.activateRuntimeSecrets,
    buildReloadPlan: params.buildReloadPlan,
    sharedGatewaySessionGenerationState: params.sharedGatewaySessionGenerationState ?? {
      current: undefined,
      required: null,
    },
    resolveSharedGatewaySessionGenerationForConfig:
      params.resolveSharedGatewaySessionGenerationForConfig ?? (() => undefined),
    clients: params.clients ?? [],
    startChannel: params.startChannel ?? (async () => {}),
    stopChannel: params.stopChannel ?? (async () => {}),
    getChannelAutostartSuppression: params.getChannelAutostartSuppression,
    logChannels: { info: params.logChannelsInfo ?? vi.fn() },
  });
  const { extraHandlers } = gatewayAux;

  return {
    ...gatewayAux,
    extraHandlers,
    respond,
    reload: () => invokeSecretsReload({ handlers: extraHandlers, respond }),
  };
}

function createSecretsReloadHarnessWithChannelMocks(
  params: Omit<SecretsReloadHarnessParams, "startChannel" | "stopChannel">,
) {
  const stopChannel = vi.fn().mockResolvedValue(undefined);
  const startChannel = vi.fn().mockResolvedValue(undefined);
  return {
    ...createSecretsReloadHarness({
      ...params,
      startChannel,
      stopChannel,
    }),
    startChannel,
    stopChannel,
  };
}

// Other gateway test helpers (e.g. test-helpers.mocks.ts, test-helpers.server.ts)
// set OPENCLAW_SKIP_CHANNELS / OPENCLAW_SKIP_PROVIDERS at module load. When a
// shared vitest worker imports those helpers before this file's tests run,
// the leaked env vars route the secrets.reload skip-mode branch and prevent
// the channel restart loop from firing. Reset them before every test so this
// suite is independent of worker import order.
beforeEach(() => {
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

describe("gateway aux handlers", () => {
  it("shares one approval epoch per gateway lifetime and rotates it on restart", () => {
    const first = createSecretsReloadHarness({
      activateRuntimeSecrets: mockResolvedSecrets(asConfig({})),
    });
    const second = createSecretsReloadHarness({
      activateRuntimeSecrets: mockResolvedSecrets(asConfig({})),
    });

    expect(first.execApprovalManager.runtimeEpoch).toBe(first.pluginApprovalManager.runtimeEpoch);
    expect(second.execApprovalManager.runtimeEpoch).toBe(second.pluginApprovalManager.runtimeEpoch);
    expect(first.execApprovalManager.runtimeEpoch).not.toBe(
      second.execApprovalManager.runtimeEpoch,
    );
  });

  it("refuses secrets.reload channel restarts while crash-loop safe mode suppresses autostart", async () => {
    const buildReloadPlan = buildRestartChannelsPlan("slack");
    activateSnapshot(slackConfig("old-slack-secret"));
    const activateRuntimeSecrets = mockResolvedSecrets(slackConfig("new-slack-secret"));
    const { reload, respond, startChannel, stopChannel } =
      createSecretsReloadHarnessWithChannelMocks({
        activateRuntimeSecrets,
        buildReloadPlan,
        getChannelAutostartSuppression: () => ({
          reason: "crash-loop-breaker",
          message: "safe mode",
        }),
      });

    await reload();

    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    const [okFlag, successPayload, errorPayload] = firstRespondCall(respond);
    expect(okFlag).toBe(false);
    expect(successPayload).toBeUndefined();
    expect(errorPayload?.message ?? "").toBe("secrets.reload failed");
  });

  it("restarts only channels whose resolved secret-backed config changed on secrets.reload", async () => {
    const buildReloadPlanCalls: string[][] = [];
    const buildReloadPlan = (changedPaths: string[]) => {
      buildReloadPlanCalls.push([...changedPaths]);
      return createReloadPlan({
        restartChannels: new Set(["slack", "zalo"]),
      });
    };
    activateSnapshot(
      slackZaloDiscordConfig("old-slack-secret", "old-zalo-secret", "unchanged-discord-token"),
    );
    const prepared = createSnapshot(
      slackZaloDiscordConfig("new-slack-secret", "new-zalo-secret", "unchanged-discord-token"),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(prepared);
    const { reload, respond, startChannel, stopChannel } =
      createSecretsReloadHarnessWithChannelMocks({
        activateRuntimeSecrets,
        buildReloadPlan,
      });

    await reload();

    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(1);
    expect(buildReloadPlanCalls).toEqual([
      ["channels.slack.signingSecret", "channels.zalo.webhookSecret"],
    ]);
    expect(stopChannel.mock.calls.map(([ch]) => ch).toSorted((a, b) => a.localeCompare(b))).toEqual(
      ["slack", "zalo"],
    );
    expect(
      startChannel.mock.calls.map(([ch]) => ch).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["slack", "zalo"]);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });

  it("restarts the whole channel when a secret change is scoped to one account", async () => {
    // secrets.reload has no per-account restart path — account-scoped plan
    // entries must still produce a channel restart so rotated credentials
    // are applied.
    const buildReloadPlan = () =>
      createReloadPlan({
        restartChannels: new Set(),
        restartChannelAccounts: new Map([["slack", new Set(["ops"])]]),
      });
    activateSnapshot(slackConfig("old-slack-secret"));
    const prepared = createSnapshot(slackConfig("new-slack-secret"));
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(prepared);
    const { reload, respond, startChannel, stopChannel } =
      createSecretsReloadHarnessWithChannelMocks({
        activateRuntimeSecrets,
        buildReloadPlan,
      });

    await reload();

    expect(stopChannel.mock.calls.map(([ch]) => ch)).toEqual(["slack"]);
    expect(startChannel.mock.calls.map(([ch]) => ch)).toEqual(["slack"]);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });

  it("coalesces concurrent secrets.reload calls so channels are not restarted twice", async () => {
    const buildReloadPlan = buildRestartChannelsPlan("slack");
    activateSnapshot(slackConfig("old-slack-secret"));

    const preparedFirst = createSnapshot(slackConfig("new-slack-secret"));
    const activationOrder: string[] = [];
    const activateRuntimeSecrets = vi.fn().mockImplementationOnce(async () => {
      activationOrder.push("first-start");
      // Yield the event loop to let a concurrent caller enter if the
      // handler were not serialized.
      await Promise.resolve();
      await Promise.resolve();
      activationOrder.push("first-end");
      return preparedFirst;
    });
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { reload } = createSecretsReloadHarness({
      activateRuntimeSecrets,
      buildReloadPlan,
      startChannel,
      stopChannel,
      respond,
    });

    await Promise.all([reload(), reload()]);

    expect(activationOrder).toEqual(["first-start", "first-end"]);
    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(1);
    expect(stopChannel.mock.calls).toEqual([["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack"]]);
    expect(respond).toHaveBeenNthCalledWith(1, true, { ok: true, warningCount: 0 });
    expect(respond).toHaveBeenNthCalledWith(2, true, { ok: true, warningCount: 0 });
  });

  it("retries from the canonical source when it changes during secrets.reload preparation", async () => {
    const initialConfig = slackConfig("initial-secret");
    const canonicalConfig = slackConfig("canonical-secret");
    activateSecretsRuntimeSnapshot(createSourceSnapshot(initialConfig));
    const activatePreparedSnapshotIfCurrent = vi.fn(
      async (
        snapshot: PreparedSecretsRuntimeSnapshot,
        expectedRevision: number,
        _params: unknown,
        onActivated?: () => void | Promise<void>,
        canActivate?: () => boolean,
      ) => {
        if (
          getActiveSecretsRuntimeSnapshotRevision() !== expectedRevision ||
          (canActivate && !canActivate())
        ) {
          return null;
        }
        activateSecretsRuntimeSnapshot(snapshot);
        await onActivated?.();
        return snapshot;
      },
    );
    const activateRuntimeSecrets = Object.assign(
      vi.fn(
        async (
          config: OpenClawConfig,
          _activationParams: Parameters<GatewayAuxHandlerParams["activateRuntimeSecrets"]>[1],
        ) => {
          if (activateRuntimeSecrets.mock.calls.length === 1) {
            activateSecretsRuntimeSnapshot(createSourceSnapshot(canonicalConfig));
          }
          return createSourceSnapshot(config);
        },
      ),
      { activatePreparedSnapshotIfCurrent },
    );
    const { reload, respond } = createSecretsReloadHarness({ activateRuntimeSecrets });

    await reload();

    expect(activateRuntimeSecrets.mock.calls.map(([config]) => config)).toEqual([
      initialConfig,
      canonicalConfig,
    ]);
    expect(activateRuntimeSecrets.mock.calls.map(([, activation]) => activation)).toEqual([
      {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
      },
      {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
      },
    ]);
    expect(activatePreparedSnapshotIfCurrent).toHaveBeenCalledTimes(2);
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(canonicalConfig);
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("rolls back stopped channels when a later restart fails", async () => {
    const authAgentDir = "/tmp/openclaw-secrets-reload-concurrent-oauth";
    const buildReloadPlan = buildRestartChannelsPlan("slack", "zalo");
    activateSnapshot(slackZaloConfig("old-slack-secret", "old-zalo-secret"));
    const activateRuntimeSecrets = mockResolvedSecrets(
      slackZaloConfig("new-slack-secret", "new-zalo-secret"),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        setRuntimeAuthProfileStoreSnapshot(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "oauth",
                provider: "openai",
                access: "access-new",
                refresh: "refresh-new",
                expires: Date.now() + 60_000,
              },
            },
          },
          authAgentDir,
        );
        throw new Error("zalo refused to start");
      })
      .mockResolvedValue(undefined);
    const logChannelsInfo = vi.fn();
    const sharedGatewaySessionGenerationState = {
      current: "gen-old" as string | undefined,
      required: "gen-old" as string | undefined | null,
    };

    const { reload, respond } = createSecretsReloadHarness({
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig: () => "gen-new",
      startChannel,
      stopChannel,
      logChannelsInfo,
    });

    await reload();

    expect(stopChannel.mock.calls).toEqual([["slack"], ["zalo"], ["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack"], ["zalo"], ["slack"], ["zalo"]]);
    expect(
      logChannelsInfo.mock.calls.some(([msg]) =>
        String(msg).startsWith("failed to restart zalo channel after secrets reload"),
      ),
    ).toBe(true);
    expect(
      logChannelsInfo.mock.calls.some(([msg]) =>
        String(msg).startsWith("rolling back slack channel after secrets reload failure"),
      ),
    ).toBe(true);
    expect(
      logChannelsInfo.mock.calls.some(([msg]) =>
        String(msg).startsWith("rolling back zalo channel after secrets reload failure"),
      ),
    ).toBe(true);
    // The handler surfaces the partial-failure so the caller can retry/alert
    // instead of treating a swallowed restart error as a successful rotation.
    expect(respond.mock.calls).toHaveLength(1);
    const [okFlag, successPayload, errorPayload] = firstRespondCall(respond);
    expect(okFlag).toBe(false);
    expect(successPayload).toBeUndefined();
    expect(errorPayload?.message ?? "").toBe("secrets.reload failed");
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
      slackZaloConfig("old-slack-secret", "old-zalo-secret"),
    );
    expect(sharedGatewaySessionGenerationState).toEqual({
      current: "gen-old",
      required: "gen-old",
    });
    expect(
      getRuntimeAuthProfileStoreSnapshot(authAgentDir)?.profiles["openai:default"],
    ).toMatchObject({ access: "access-new", refresh: "refresh-new" });
  });

  it("does not roll back over a snapshot published after secrets.reload activation", async () => {
    const buildReloadPlan = buildRestartChannelsPlan("slack");
    activateSnapshot(slackConfig("old-slack-secret"));
    const prepared = createSnapshot(slackConfig("reload-secret"));
    const concurrent = createSnapshot(slackConfig("concurrent-secret"));
    const activateRuntimeSecrets = vi.fn(
      async (
        _config: OpenClawConfig,
        _activationParams: Parameters<GatewayAuxHandlerParams["activateRuntimeSecrets"]>[1],
      ) => {
        return prepared;
      },
    );
    const sharedGatewaySessionGenerationState = {
      current: "gen-old" as string | undefined,
      required: "gen-old" as string | undefined | null,
    };
    const startChannel = vi
      .fn()
      .mockImplementationOnce(async () => {
        activateSecretsRuntimeSnapshot(concurrent);
        publishSharedGatewayGeneration(sharedGatewaySessionGenerationState, "gen-concurrent");
        throw new Error("slack refused to start");
      })
      .mockResolvedValue(undefined);

    const { reload, respond } = createSecretsReloadHarness({
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig: () => "gen-reload",
      startChannel,
      stopChannel: vi.fn().mockResolvedValue(undefined),
    });

    await reload();

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(startChannel).toHaveBeenCalledTimes(2);
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(slackConfig("concurrent-secret"));
    expect(sharedGatewaySessionGenerationState).toEqual({
      current: "gen-concurrent",
      required: "gen-concurrent",
    });
  });

  it("rolls back a failed snapshot without overwriting newer generation-only state", async () => {
    const initialConfig = slackConfig("old-slack-secret");
    const prepared = createSourceSnapshot(slackConfig("reload-secret"));
    activateSecretsRuntimeSnapshot(createSourceSnapshot(initialConfig));
    const sharedGatewaySessionGenerationState = {
      current: "gen-old" as string | undefined,
      required: "gen-old" as string | undefined | null,
    };
    const startChannel = vi
      .fn()
      .mockImplementationOnce(async () => {
        publishSharedGatewayGeneration(sharedGatewaySessionGenerationState, "gen-concurrent");
        throw new Error("slack refused to start");
      })
      .mockResolvedValue(undefined);
    const { reload, respond } = createSecretsReloadHarness({
      activateRuntimeSecrets: vi.fn(async () => prepared),
      buildReloadPlan: buildRestartChannelsPlan("slack"),
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig: () => "gen-reload",
      startChannel,
      stopChannel: vi.fn().mockResolvedValue(undefined),
    });

    await reload();

    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(startChannel).toHaveBeenCalledTimes(2);
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(initialConfig);
    expect(sharedGatewaySessionGenerationState).toEqual({
      current: "gen-concurrent",
      required: "gen-concurrent",
    });
  });

  it("attempts restart on rollback even when stopChannel itself throws mid-reload", async () => {
    // If stopChannel throws after partially stopping a channel (for example,
    // a plugin hook rejects after the runtime already closed the socket),
    // the rollback path must still try to restart that channel; otherwise a
    // failed secrets.reload can leave it down.
    const buildReloadPlan = buildRestartChannelsPlan("slack", "zalo");
    activateSnapshot(slackZaloConfig("old-slack-secret", "old-zalo-secret"));
    const activateRuntimeSecrets = mockResolvedSecrets(
      slackZaloConfig("new-slack-secret", "new-zalo-secret"),
    );
    const stopChannel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("zalo stop hook failed after socket close"));
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const logChannelsInfo = vi.fn();

    const { reload, respond } = createSecretsReloadHarness({
      activateRuntimeSecrets,
      buildReloadPlan,
      startChannel,
      stopChannel,
      logChannelsInfo,
    });

    await reload();

    // Both channels appear in the rollback log, including zalo whose
    // stopChannel rejected.
    const rollbackLogs = logChannelsInfo.mock.calls
      .map(([msg]) => String(msg))
      .filter((msg) => msg.startsWith("rolling back "));
    expect(rollbackLogs.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "rolling back slack channel after secrets reload failure",
      "rolling back zalo channel after secrets reload failure",
    ]);
    // startChannel was invoked for zalo on rollback even though the original
    // stopChannel(zalo) rejected.
    expect(startChannel.mock.calls.map(([ch]) => ch)).toEqual(["slack", "slack", "zalo"]);
    expect(respond.mock.calls).toHaveLength(1);
    expect(firstRespondCall(respond)[0]).toBe(false);
  });

  it("restores both current and required shared-gateway generation on reload failure", async () => {
    // Locks in the auth-generation rollback contract: a failed reload must
    // not leave `required` cleared if `setCurrentSharedGatewaySessionGeneration`
    // cleared it during activation, otherwise stale clients matching `current`
    // could remain authorized after rollback.
    const buildReloadPlan = buildRestartChannelsPlan("slack");
    activateSnapshot(slackConfig("old-slack-secret"));
    const activateRuntimeSecrets = mockResolvedSecrets(slackConfig("new-slack-secret"));
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockRejectedValue(new Error("slack refused to start"));

    const sharedGatewaySessionGenerationState = {
      current: "gen-a" as string | undefined,
      required: "gen-a" as string | undefined | null,
    };

    const { reload, respond } = createSecretsReloadHarness({
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig: () => "gen-b",
      startChannel,
      stopChannel,
    });

    await reload();

    expect(sharedGatewaySessionGenerationState.current).toBe("gen-a");
    expect(sharedGatewaySessionGenerationState.required).toBe("gen-a");
    expect(respond.mock.calls).toHaveLength(1);
    expect(firstRespondCall(respond)[0]).toBe(false);
  });

  it("fails reload when channel restarts are required but skip flags block them", async () => {
    const buildReloadPlan = buildRestartChannelsPlan("slack");
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    activateSnapshot(slackConfig("old-slack-secret"));
    const activateRuntimeSecrets = mockResolvedSecrets(slackConfig("new-slack-secret"));

    const { reload, respond, startChannel, stopChannel } =
      createSecretsReloadHarnessWithChannelMocks({
        activateRuntimeSecrets,
        buildReloadPlan,
      });

    await reload();

    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "UNAVAILABLE",
          message: "secrets.reload failed",
        },
      ],
    ]);
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(slackConfig("old-slack-secret"));
  });

  it("does not restart channels when resolved secrets do not change channel config", async () => {
    const buildReloadPlanCalls: string[][] = [];
    const buildReloadPlan = (changedPaths: string[]) => {
      buildReloadPlanCalls.push([...changedPaths]);
      return createReloadPlan();
    };
    activateSnapshot(gatewayTokenSlackConfig("old-token", "same-secret"));
    const activateRuntimeSecrets = mockResolvedSecrets(
      gatewayTokenSlackConfig("new-token", "same-secret"),
    );

    const { reload, respond, startChannel, stopChannel } =
      createSecretsReloadHarnessWithChannelMocks({
        activateRuntimeSecrets,
        buildReloadPlan,
      });

    await reload();

    expect(buildReloadPlanCalls).toEqual([["gateway.auth.token"]]);
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });
});
