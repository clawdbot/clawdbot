import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";

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
    disposeMcpRuntimes: overrides?.disposeMcpRuntimes ?? false,
    noopPaths: overrides?.noopPaths ?? [],
  };
}

function createSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: asConfig({}),
    config,
    authStores: [],
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  };
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
  it("restarts only channels whose resolved secret-backed config changed on secrets.reload", async () => {
    const buildReloadPlanCalls: string[][] = [];
    const buildReloadPlan = (changedPaths: string[]) => {
      buildReloadPlanCalls.push([...changedPaths]);
      return createReloadPlan({
        restartChannels: new Set(["slack", "zalo"]),
      });
    };
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "old-slack-secret" },
            zalo: { webhookSecret: "old-zalo-secret" },
            discord: { token: "unchanged-discord-token" },
          },
        }),
      ),
    );
    const prepared = createSnapshot(
      asConfig({
        channels: {
          slack: { signingSecret: "new-slack-secret" },
          zalo: { webhookSecret: "new-zalo-secret" },
          discord: { token: "unchanged-discord-token" },
        },
      }),
    );
    const activateRuntimeSecrets = vi.fn().mockImplementation(async () => {
      activateSecretsRuntimeSnapshot(prepared);
      return prepared;
    });
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

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

  it("coalesces concurrent secrets.reload calls so channels are not restarted twice", async () => {
    const buildReloadPlan = () =>
      createReloadPlan({
        restartChannels: new Set(["slack"]),
      });
    const initialActive = createSnapshot(
      asConfig({
        channels: {
          slack: { signingSecret: "old-slack-secret" },
        },
      }),
    );
    activateSecretsRuntimeSnapshot(initialActive);

    const preparedFirst = createSnapshot(
      asConfig({
        channels: {
          slack: { signingSecret: "new-slack-secret" },
        },
      }),
    );
    const activationOrder: string[] = [];
    const activateRuntimeSecrets = vi.fn().mockImplementationOnce(async () => {
      activationOrder.push("first-start");
      // Yield the event loop to let a concurrent caller enter if the
      // handler were not serialized.
      await Promise.resolve();
      await Promise.resolve();
      activateSecretsRuntimeSnapshot(preparedFirst);
      activationOrder.push("first-end");
      return preparedFirst;
    });
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await Promise.all([
      invokeSecretsReload({ handlers: extraHandlers, respond }),
      invokeSecretsReload({ handlers: extraHandlers, respond }),
    ]);

    expect(activationOrder).toEqual(["first-start", "first-end"]);
    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(1);
    expect(stopChannel.mock.calls).toEqual([["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack"]]);
    expect(respond).toHaveBeenNthCalledWith(1, true, { ok: true, warningCount: 0 });
    expect(respond).toHaveBeenNthCalledWith(2, true, { ok: true, warningCount: 0 });
  });

  it("rolls back stopped channels when a later restart fails", async () => {
    const buildReloadPlan = () =>
      createReloadPlan({
        restartChannels: new Set(["slack", "zalo"]),
      });
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "old-slack-secret" },
            zalo: { webhookSecret: "old-zalo-secret" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "new-slack-secret" },
            zalo: { webhookSecret: "new-zalo-secret" },
          },
        }),
      ),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        throw new Error("zalo refused to start");
      })
      .mockResolvedValue(undefined);
    const logChannelsInfo = vi.fn();
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: logChannelsInfo },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

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
    const [okFlag, successPayload, errorPayload] = respond.mock.calls.at(0) ?? [];
    expect(okFlag).toBe(false);
    expect(successPayload).toBeUndefined();
    expect(String(errorPayload?.message ?? "")).toBe("secrets.reload failed");
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
      asConfig({
        channels: {
          slack: { signingSecret: "old-slack-secret" },
          zalo: { webhookSecret: "old-zalo-secret" },
        },
      }),
    );
  });

  it("attempts restart on rollback even when stopChannel itself throws mid-reload", async () => {
    // If stopChannel throws after partially stopping a channel (for example,
    // a plugin hook rejects after the runtime already closed the socket),
    // the rollback path must still try to restart that channel; otherwise a
    // failed secrets.reload can leave it down.
    const buildReloadPlan = () =>
      createReloadPlan({
        restartChannels: new Set(["slack", "zalo"]),
      });
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "old-slack-secret" },
            zalo: { webhookSecret: "old-zalo-secret" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "new-slack-secret" },
            zalo: { webhookSecret: "new-zalo-secret" },
          },
        }),
      ),
    );
    const stopChannel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("zalo stop hook failed after socket close"));
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const logChannelsInfo = vi.fn();
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: logChannelsInfo },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

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
    expect(respond.mock.calls.at(0)?.[0]).toBe(false);
  });

  it("restores both current and required shared-gateway generation on reload failure", async () => {
    // Locks in the auth-generation rollback contract: a failed reload must
    // not leave `required` cleared if `setCurrentSharedGatewaySessionGeneration`
    // cleared it during activation, otherwise stale clients matching `current`
    // could remain authorized after rollback.
    const buildReloadPlan = () =>
      createReloadPlan({
        restartChannels: new Set(["slack"]),
      });
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: { slack: { signingSecret: "old-slack-secret" } },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          channels: { slack: { signingSecret: "new-slack-secret" } },
        }),
      ),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockRejectedValue(new Error("slack refused to start"));
    const respond = vi.fn();

    const sharedGatewaySessionGenerationState = {
      current: "gen-a" as string | undefined,
      required: "gen-a" as string | undefined | null,
    };

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig: () => "gen-b",
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    expect(sharedGatewaySessionGenerationState.current).toBe("gen-a");
    expect(sharedGatewaySessionGenerationState.required).toBe("gen-a");
    expect(respond.mock.calls).toHaveLength(1);
    expect(respond.mock.calls.at(0)?.[0]).toBe(false);
  });

  it("fails reload when channel restarts are required but skip flags block them", async () => {
    const buildReloadPlan = () =>
      createReloadPlan({
        restartChannels: new Set(["slack"]),
      });
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "old-slack-secret" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "new-slack-secret" },
          },
        }),
      ),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

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
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
      asConfig({
        channels: {
          slack: { signingSecret: "old-slack-secret" },
        },
      }),
    );
  });

  it("does not restart channels when resolved secrets do not change channel config", async () => {
    const buildReloadPlanCalls: string[][] = [];
    const buildReloadPlan = (changedPaths: string[]) => {
      buildReloadPlanCalls.push([...changedPaths]);
      return createReloadPlan();
    };
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          gateway: {
            auth: { mode: "token", token: "old-token" },
          },
          channels: {
            slack: { signingSecret: "same-secret" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          gateway: {
            auth: { mode: "token", token: "new-token" },
          },
          channels: {
            slack: { signingSecret: "same-secret" },
          },
        }),
      ),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    expect(buildReloadPlanCalls).toEqual([["gateway.auth.token"]]);
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });
});
