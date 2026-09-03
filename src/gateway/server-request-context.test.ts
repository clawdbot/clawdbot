/**
 * Gateway request context construction tests.
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { listSystemPresence } from "../infra/system-presence.js";
import {
  ensureProfileForEmail,
  getUserProfileDisplay,
  linkEmail,
  resolveUserProfileId,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type GatewayRequestContextParams = Parameters<typeof createGatewayRequestContext>[0];
type TestCronState = GatewayServerLiveState["cronState"];

function makeCronState(overrides: Partial<TestCronState> = {}): TestCronState {
  return {
    cron: { start: vi.fn(), stop: vi.fn() } as never,
    storePath: "/tmp/cron",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
    ...overrides,
  };
}

function makeContextParams(
  overrides: Partial<GatewayRequestContextParams> = {},
): GatewayRequestContextParams {
  const config = {} as never;
  const runtimeState: Pick<GatewayServerLiveState, "cronState"> = {
    cronState: makeCronState({
      cron: { start: vi.fn(), stop: vi.fn() } as never,
      storePath: "/tmp/cron",
    }),
  };
  return {
    deps: {} as never,
    runtimeState,
    getRuntimeConfig: vi.fn(() => config),
    isConfigReloadSettled: vi.fn(() => true),
    getGatewayMethodRegistry: vi.fn(() => ({}) as never),
    sessionCompanion: {} as never,
    sessionObserver: {} as never,
    resolveTerminalLaunchPolicy: vi.fn(() => ({
      ok: false as const,
      block: { kind: "disabled" as const },
    })),
    isTerminalEnabled: vi.fn(() => false),
    execApprovalManager: undefined,
    pluginApprovalManager: undefined,
    placementStandingGrants: undefined,
    validateAgentRuntimeApprovalAuthority: () => false,
    listSessionPendingApprovals: undefined,
    loadGatewayModelCatalog: vi.fn(async () => []),
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
      agentId: "main",
      agentDir: "/tmp/model-catalog-agent",
      catalogComplete: false,
      workspaceDir: "/tmp/model-catalog-workspace",
      config,
      entries: [],
      routeVariants: [],
    })),
    readChatMetadata: vi.fn(async () => ({ swarmEnabled: false })),
    getHealthCache: vi.fn(() => null),
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    logHealth: { error: vi.fn() },
    logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    incrementPresenceVersion: vi.fn(() => 1),
    getHealthVersion: vi.fn(() => 1),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    nodeSubscribe: vi.fn(),
    nodeUnsubscribe: vi.fn(),
    nodeUnsubscribeAll: vi.fn(),
    hasConnectedTalkNode: vi.fn(async () => false),
    clients: new Set(),
    isConnectionActive: vi.fn(() => false),
    enforceSharedGatewayAuthGenerationForConfigWrite: vi.fn(),
    nodeRegistry: { invalidateConnectionForPairingChange: vi.fn() } as never,
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    subscribeSessionEvents: vi.fn(),
    unsubscribeSessionEvents: vi.fn(),
    subscribeSessionMessageEvents: vi.fn(),
    unsubscribeSessionMessageEvents: vi.fn(),
    unsubscribeAllSessionEvents: vi.fn(),
    getSessionEventSubscriberConnIds: vi.fn(() => new Set<string>()),
    registerToolEventRecipient: vi.fn(),
    dedupe: new Map(),
    wizardSessions: new Map(),
    trackWizardSession: vi.fn(),
    findOwnedWizardSession: vi.fn(),
    systemAgentSessions: new Map(),
    findRunningWizard: vi.fn(() => null),
    purgeWizardSession: vi.fn(),
    handleWizardDisconnect: vi.fn(),
    getRuntimeSnapshot: vi.fn(() => ({}) as never),
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => undefined),
    markChannelLoggedOut: vi.fn(),
    wizardRunner: vi.fn(async () => undefined),
    channelWizardRunner: vi.fn(async () => undefined),
    broadcastVoiceWakeChanged: vi.fn(),
    broadcastVoiceWakeRoutingChanged: vi.fn(),
    notifyPluginMetadataChanged: vi.fn(),
    getConfigReloaderHotReloadStatus: vi.fn(() => undefined),
    unavailableGatewayMethods: new Set(),
    ...overrides,
    configRevisionProjector: overrides.configRevisionProjector ?? {
      projectRawHash: (hash) => hash,
      projectResolvedHash: (hash) => hash,
    },
  };
}

function makeGatewayClient(params: {
  connId: string;
  clientId: (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];
  mode?: (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];
  scopes?: string[];
  caps?: string[];
  approvalRuntime?: boolean;
  invalidated?: boolean;
}) {
  return {
    connId: params.connId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: params.clientId,
        version: "test",
        platform: "test",
        mode: params.mode ?? GATEWAY_CLIENT_MODES.CLI,
      },
      scopes: params.scopes ?? [],
      caps: params.caps ?? [],
    },
    socket: { close: vi.fn(), readyState: 1 },
    ...(params.approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
    ...(params.invalidated ? { invalidated: true } : {}),
  };
}

describe("createGatewayRequestContext", () => {
  it("reuses the canonical connection liveness predicate", () => {
    const isConnectionActive = vi.fn(() => true);
    const params = makeContextParams();
    Object.assign(params, { isConnectionActive });

    const context = createGatewayRequestContext(params);

    expect(context.isConnectionActive).toBe(isConnectionActive);
  });

  it("cleans connection-scoped replace-sets with the other session subscriptions", () => {
    const unsubscribeAllSessionEvents = vi.fn();
    const unsubscribePullRequests = vi.fn();
    const unsubscribeViewerPresence = vi.fn();
    const params = makeContextParams({ unsubscribeAllSessionEvents });
    params.runtimeState.controlUiSessionPullRequests = {
      unsubscribe: unsubscribePullRequests,
    } as never;
    params.runtimeState.sessionViewerPresence = {
      unsubscribe: unsubscribeViewerPresence,
    } as never;
    const context = createGatewayRequestContext(params);

    context.unsubscribeAllSessionEvents("conn-control-ui");

    expect(unsubscribeAllSessionEvents).toHaveBeenCalledWith("conn-control-ui");
    expect(unsubscribePullRequests).toHaveBeenCalledWith("conn-control-ui");
    expect(unsubscribeViewerPresence).toHaveBeenCalledWith("conn-control-ui");
  });

  it("reads cron state live from runtime state", () => {
    const cronA = { start: vi.fn(), stop: vi.fn() } as never;
    const cronB = { start: vi.fn(), stop: vi.fn() } as never;
    const runtimeState: Pick<GatewayServerLiveState, "cronState"> = {
      cronState: makeCronState({ cron: cronA, storePath: "/tmp/cron-a" }),
    };

    const context = createGatewayRequestContext(makeContextParams({ runtimeState }));

    expect(context.cron).toBe(cronA);
    expect(context.cronStorePath).toBe("/tmp/cron-a");

    runtimeState.cronState = makeCronState({ cron: cronB, storePath: "/tmp/cron-b" });

    expect(context.cron).toBe(cronB);
    expect(context.cronStorePath).toBe("/tmp/cron-b");
  });

  it("reads config reload status and readiness through the live kernel bridge", () => {
    let status: "active" | "disabled" | undefined;
    let settled = true;
    const context = createGatewayRequestContext(
      makeContextParams({
        getConfigReloaderHotReloadStatus: () => status,
        isConfigReloadSettled: () => settled,
      }),
    );

    expect(context.getConfigReloaderHotReloadStatus?.()).toBeUndefined();

    status = "active";
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("active");
    expect(context.isConfigReloadSettled()).toBe(true);
    settled = false;
    expect(context.isConfigReloadSettled()).toBe(false);

    status = "disabled";
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("disabled");
  });

  it("publishes the worker disk-space reader through the kernel bridge", () => {
    const workerPlacementDiskSpaceReader = { read: vi.fn(), version: vi.fn(() => 1) };
    const context = createGatewayRequestContext(
      makeContextParams({ workerPlacementDiskSpaceReader }),
    );

    expect(context.workerPlacementDiskSpaceReader).toBe(workerPlacementDiskSpaceReader);
  });

  it("routes plugin metadata changes through the kernel bridge", () => {
    const notifyPluginMetadataChanged = vi.fn();
    const context = createGatewayRequestContext(makeContextParams({ notifyPluginMetadataChanged }));

    context.notifyPluginMetadataChanged();

    expect(notifyPluginMetadataChanged).toHaveBeenCalledOnce();
  });

  it("does not treat scoped CLI or backend callers as approval delivery routes", () => {
    const clients = new Set([
      makeGatewayClient({
        connId: "cli",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.admin"],
      }),
      makeGatewayClient({
        connId: "backend",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: ["operator.approvals"],
      }),
    ]) as never;
    const context = createGatewayRequestContext(makeContextParams({ clients }));

    expect(context.hasExecApprovalClients?.()).toBe(false);
    expect(context.getApprovalClientConnIds?.()).toEqual(new Set());
    expect(context.getApprovalClientConnIds?.({ approvalKind: "plugin" })).toEqual(new Set());
  });

  it("refreshes every live connection and presence row for a changed user profile", () => {
    const first = {
      ...makeGatewayClient({
        connId: "ada-one",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: {
        profileId: "profile-ada",
        displayName: "Ada",
        avatarRevision: "avatar-old-png",
        hasAvatar: true,
        updatedAt: 1,
      },
      presenceKey: "profile-refresh-ada-one",
    };
    const second = {
      ...makeGatewayClient({
        connId: "ada-two",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: "ada@work.test",
      authenticatedUserProfile: {
        profileId: "profile-ada",
        displayName: "Ada",
        avatarRevision: "avatar-old-png",
        hasAvatar: true,
        updatedAt: 1,
      },
      presenceKey: "profile-refresh-ada-two",
    };
    const unrelated = {
      ...makeGatewayClient({
        connId: "grace",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: "grace@example.test",
      authenticatedUserProfile: {
        profileId: "profile-grace",
        displayName: "Grace",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      },
      presenceKey: "profile-refresh-grace",
    };
    const clients = new Set([first, second, unrelated]) as never;
    const params = makeContextParams({ clients });
    const context = createGatewayRequestContext(params);
    const capturedFirstProfile = first.authenticatedUserProfile;
    const readCapturedDisplayName = () => capturedFirstProfile.displayName;

    context.refreshConnectedUserProfile?.({
      id: "profile-ada",
      displayName: "Augusta Ada",
      avatarRevision: "avatar-new-png",
      hasAvatar: true,
      updatedAt: 2,
    });

    context.refreshConnectedUserProfile?.({
      id: "profile-ada",
      displayName: "Augusta Ada",
      avatarRevision: "avatar-newer-png",
      hasAvatar: true,
      updatedAt: 2,
    });

    expect(first.authenticatedUserProfile).toEqual({
      profileId: "profile-ada",
      displayName: "Augusta Ada",
      avatarRevision: "avatar-newer-png",
      hasAvatar: true,
      updatedAt: 2,
    });
    expect(first.authenticatedUserProfile).toBe(capturedFirstProfile);
    expect(readCapturedDisplayName()).toBe("Augusta Ada");
    expect(second.authenticatedUserProfile).toEqual(first.authenticatedUserProfile);
    expect(unrelated.authenticatedUserProfile.displayName).toBe("Grace");
    expect(params.broadcast).toHaveBeenNthCalledWith(
      1,
      "presence",
      {
        presence: expect.arrayContaining([
          expect.objectContaining({
            user: {
              id: "profile-ada",
              identity: { type: "profile", id: "profile-ada" },
              email: "ada@example.test",
              name: "Augusta Ada",
              avatarUrl: "/api/users/profile-ada/avatar?v=avatar-new-png",
            },
          }),
          expect.objectContaining({
            user: {
              id: "profile-ada",
              identity: { type: "profile", id: "profile-ada" },
              email: "ada@work.test",
              name: "Augusta Ada",
              avatarUrl: "/api/users/profile-ada/avatar?v=avatar-new-png",
            },
          }),
        ]),
      },
      {
        dropIfSlow: true,
        stateVersion: { presence: 1, health: 1 },
      },
    );
    expect(params.broadcast).toHaveBeenNthCalledWith(
      2,
      "presence",
      {
        presence: expect.arrayContaining([
          expect.objectContaining({
            user: {
              id: "profile-ada",
              identity: { type: "profile", id: "profile-ada" },
              email: "ada@example.test",
              name: "Augusta Ada",
              avatarUrl: "/api/users/profile-ada/avatar?v=avatar-newer-png",
            },
          }),
          expect.objectContaining({
            user: {
              id: "profile-ada",
              identity: { type: "profile", id: "profile-ada" },
              email: "ada@work.test",
              name: "Augusta Ada",
              avatarUrl: "/api/users/profile-ada/avatar?v=avatar-newer-png",
            },
          }),
        ]),
      },
      {
        dropIfSlow: true,
        stateVersion: { presence: 1, health: 1 },
      },
    );
  });

  it("canonicalizes a connected profile after its durable identity is merged", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = ensureProfileForEmail("merge-source@example.test");
      const target = ensureProfileForEmail("merge-target@example.test");
      const unrelatedProfile = ensureProfileForEmail("merge-unrelated@example.test");
      const sourceClient = {
        ...makeGatewayClient({
          connId: "merge-source",
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        authenticatedUserId: "merge-source@example.test",
        authenticatedUserProfile: {
          profileId: source.id,
          displayName: source.displayName,
          avatarRevision: String(source.updatedAt),
          hasAvatar: false,
          updatedAt: source.updatedAt,
        },
        presenceKey: "profile-refresh-merge-source",
        personPresence: { onlineSince: 1_000, lastActivityAt: 2_000 },
      };
      const targetClient = {
        ...sourceClient,
        connId: "merge-target",
        authenticatedUserId: "merge-target@example.test",
        authenticatedUserProfile: {
          ...sourceClient.authenticatedUserProfile,
          profileId: target.id,
        },
        presenceKey: "profile-refresh-merge-target",
        personPresence: { onlineSince: 1_500, lastActivityAt: 3_000 },
      };
      const unrelatedClient = {
        ...makeGatewayClient({
          connId: "merge-unrelated",
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        authenticatedUserId: "merge-unrelated@example.test",
        authenticatedUserProfile: {
          profileId: unrelatedProfile.id,
          displayName: unrelatedProfile.displayName,
          avatarRevision: String(unrelatedProfile.updatedAt),
          hasAvatar: false,
          updatedAt: unrelatedProfile.updatedAt,
        },
        presenceKey: "profile-refresh-merge-unrelated",
      };
      const capturedProfile = sourceClient.authenticatedUserProfile;
      const params = makeContextParams({
        clients: new Set([sourceClient, targetClient, unrelatedClient]) as never,
      });
      const context = createGatewayRequestContext(params);

      const linked = linkEmail("merge-source@example.test", target.id);
      expect(resolveUserProfileId(source.id)).toBe(target.id);
      const display = getUserProfileDisplay(linked.id);
      context.refreshConnectedUserProfile?.({
        ...display,
        updatedAt: linked.updatedAt,
      });

      expect(sourceClient.authenticatedUserProfile).toBe(capturedProfile);
      expect(sourceClient.authenticatedUserProfile).toEqual({
        profileId: target.id,
        displayName: target.displayName,
        avatarRevision: display.avatarRevision,
        hasAvatar: false,
        updatedAt: linked.updatedAt,
      });
      expect(unrelatedClient.authenticatedUserProfile.profileId).toBe(unrelatedProfile.id);
      for (const email of ["merge-source@example.test", "merge-target@example.test"]) {
        expect(listSystemPresence().find((entry) => entry.user?.email === email)).toMatchObject({
          user: { id: target.id, identity: { type: "profile", id: target.id } },
          onlineSince: 1_000,
          lastActivityAt: 3_000,
        });
      }
      const presence = vi.mocked(params.broadcast).mock.calls[0]?.[1] as {
        presence?: Array<{ user?: { id?: string; email?: string; avatarUrl?: string } }>;
      };
      expect(
        presence.presence?.find((entry) => entry.user?.email === "merge-source@example.test")?.user,
      ).toEqual({
        id: target.id,
        identity: { type: "profile", id: target.id },
        email: "merge-source@example.test",
        name: target.displayName,
        avatarUrl: `/api/users/${target.id}/avatar?v=${display.avatarRevision}`,
      });
      expect(presence.presence?.some((entry) => entry.user?.id === unrelatedProfile.id)).toBe(
        false,
      );
    });
  });

  it("publishes an owner rename to every tab without inventing an email", () => {
    const ownerClients = [];
    for (const tab of ["one", "two"]) {
      ownerClients.push({
        ...makeGatewayClient({
          connId: `owner-${tab}`,
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        authenticatedUserProfile: {
          profileId: "profile-owner",
          displayName: "Ada",
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: 1,
        },
        presenceKey: `profile-owner-${tab}`,
        personPresence: { onlineSince: 1_000 },
      });
    }
    const params = makeContextParams({ clients: new Set(ownerClients) as never });
    createGatewayRequestContext(params).refreshConnectedUserProfile?.({
      id: "profile-owner",
      displayName: "Augusta Ada",
      avatarRevision: "2",
      hasAvatar: false,
      updatedAt: 2,
    });

    for (const client of ownerClients) {
      expect(client.authenticatedUserProfile.displayName).toBe("Augusta Ada");
    }
    const ownerRows = listSystemPresence().filter((entry) => entry.user?.id === "profile-owner");
    expect(ownerRows).toHaveLength(2);
    for (const entry of ownerRows) {
      expect(entry.user).toEqual({
        id: "profile-owner",
        identity: { type: "profile", id: "profile-owner" },
        name: "Augusta Ada",
        avatarUrl: "/api/users/profile-owner/avatar?v=2",
      });
    }
    expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
      "presence",
      { presence: expect.arrayContaining(ownerRows) },
      { dropIfSlow: true, stateVersion: { presence: 1, health: 1 } },
    );
  });

  it("publishes only server-stamped activity from the exact live client", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    onTestFinished(() => now.mockRestore());
    const client: GatewayWsClient = {
      ...makeGatewayClient({ connId: "activity-live", clientId: GATEWAY_CLIENT_IDS.CONTROL_UI }),
      socket: { readyState: 1 } as GatewayWsClient["socket"],
      usesSharedGatewayAuth: false,
      presenceKey: "activity-live",
      authenticatedUserId: "live@activity.test",
      personPresence: { onlineSince: 9_000 },
    };
    const clients = new Set([client]);
    const params = makeContextParams({ clients });
    const context = createGatewayRequestContext(params);
    context.recordClientActivity?.({ ...client });
    expect(params.broadcast).not.toHaveBeenCalled();
    context.recordClientActivity?.(client);
    expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
      "presence",
      {
        presence: expect.arrayContaining([
          expect.objectContaining({
            user: { id: "live@activity.test", email: "live@activity.test" },
            onlineSince: 9_000,
            lastActivityAt: 10_000,
          }),
        ]),
      },
      { dropIfSlow: true, stateVersion: { presence: 1, health: 1 } },
    );
    now.mockReturnValue(11_000);
    clients.delete(client);
    context.recordClientActivity?.(client);
    expect(params.broadcast).toHaveBeenCalledOnce();
  });

  it.each(["removed", "invalidated", "closing"] as const)(
    "does not refresh a %s profile connection or resurrect its presence",
    (state) => {
      const client: GatewayWsClient = {
        ...makeGatewayClient({
          connId: `profile-${state}`,
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        socket: { readyState: state === "closing" ? 2 : 1 } as GatewayWsClient["socket"],
        usesSharedGatewayAuth: false,
        authenticatedUserId: `${state}@profile.test`,
        authenticatedUserProfile: {
          profileId: `inactive-${state}`,
          displayName: "Before",
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: 1,
        },
        presenceKey: `profile-${state}`,
        invalidated: state === "invalidated",
      };
      const params = makeContextParams({ clients: new Set(state === "removed" ? [] : [client]) });
      createGatewayRequestContext(params).refreshConnectedUserProfile?.({
        id: `inactive-${state}`,
        displayName: "After",
        avatarRevision: "2",
        hasAvatar: false,
        updatedAt: 2,
      });
      expect(client.authenticatedUserProfile?.displayName).toBe("Before");
      expect(params.broadcast).not.toHaveBeenCalled();
      expect(
        listSystemPresence().some((entry) => entry.user?.email === `${state}@profile.test`),
      ).toBe(false);
    },
  );

  it("preserves the Gravatar-backed route when a changed profile has no upload", () => {
    const client = {
      ...makeGatewayClient({
        connId: "ada-avatar-removed",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: {
        profileId: "profile-ada-avatar-removed",
        displayName: "Ada",
        avatarRevision: "avatar-upload-png",
        hasAvatar: true,
        updatedAt: 1,
      },
      presenceKey: "profile-refresh-ada-avatar-removed",
    };
    const params = makeContextParams({ clients: new Set([client]) as never });
    const context = createGatewayRequestContext(params);

    context.refreshConnectedUserProfile?.({
      id: "profile-ada-avatar-removed",
      displayName: "Ada",
      avatarRevision: "profile-updated-2",
      hasAvatar: false,
      updatedAt: 2,
    });

    expect(client.authenticatedUserProfile.hasAvatar).toBe(false);
    const presence = vi.mocked(params.broadcast).mock.calls[0]?.[1] as {
      presence?: Array<{ user?: { id?: string; avatarUrl?: string } }>;
    };
    expect(
      presence.presence?.find((entry) => entry.user?.id === "profile-ada-avatar-removed")?.user,
    ).toEqual({
      id: "profile-ada-avatar-removed",
      identity: { type: "profile", id: "profile-ada-avatar-removed" },
      email: "ada@example.test",
      name: "Ada",
      avatarUrl: "/api/users/profile-ada-avatar-removed/avatar?v=profile-updated-2",
    });
  });

  it("keeps Tailscale provider identities out of refreshed presence email", () => {
    const client = {
      ...makeGatewayClient({
        connId: "ada-tailscale",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
      authenticatedUserProfile: {
        profileId: "profile-ada-tailscale",
        displayName: "Ada",
        avatarRevision: "avatar-tailscale-png",
        hasAvatar: true,
        updatedAt: 1,
      },
      presenceKey: "profile-refresh-ada-tailscale",
    };
    const params = makeContextParams({ clients: new Set([client]) as never });
    const context = createGatewayRequestContext(params);

    context.refreshConnectedUserProfile?.({
      id: "profile-ada-tailscale",
      displayName: "Augusta Ada",
      avatarRevision: "avatar-tailscale-new-png",
      hasAvatar: true,
      updatedAt: 2,
    });

    const presence = vi.mocked(params.broadcast).mock.calls[0]?.[1] as {
      presence?: Array<{ user?: { id?: string; email?: string } }>;
    };
    expect(
      presence.presence?.find((entry) => entry.user?.id === "profile-ada-tailscale")?.user,
    ).toEqual({
      id: "profile-ada-tailscale",
      identity: { type: "profile", id: "profile-ada-tailscale" },
      name: "Augusta Ada",
      avatarUrl: "/api/users/profile-ada-tailscale/avatar?v=avatar-tailscale-new-png",
    });
  });

  it("preserves only clients that handle each approval kind", () => {
    const clients = new Set([
      makeGatewayClient({
        connId: "control-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        scopes: ["operator.approvals"],
      }),
      makeGatewayClient({
        connId: "ios",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        mode: GATEWAY_CLIENT_MODES.UI,
        scopes: ["operator.admin"],
      }),
      makeGatewayClient({
        connId: "bridge",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      }),
      makeGatewayClient({
        connId: "acp",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
      }),
      makeGatewayClient({
        connId: "tui",
        clientId: GATEWAY_CLIENT_IDS.TUI,
        scopes: ["operator.approvals"],
      }),
      makeGatewayClient({
        connId: "plugin-bridge",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS],
      }),
      makeGatewayClient({
        connId: "runtime",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: ["operator.approvals"],
        approvalRuntime: true,
      }),
      makeGatewayClient({
        connId: "invalidated-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        scopes: ["operator.approvals"],
        invalidated: true,
      }),
      makeGatewayClient({
        connId: "unscoped-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
    ]) as never;
    const context = createGatewayRequestContext(makeContextParams({ clients }));

    expect(context.hasExecApprovalClients?.()).toBe(true);
    expect(context.getApprovalClientConnIds?.()).toEqual(
      new Set(["control-ui", "ios", "bridge", "acp", "runtime"]),
    );
    expect(context.getApprovalClientConnIds?.({ approvalKind: "plugin" })).toEqual(
      new Set(["control-ui", "bridge", "tui", "plugin-bridge", "runtime"]),
    );
    expect(context.getApprovalClientConnIds?.({ approvalKind: "system-agent" })).toEqual(
      new Set(["control-ui", "bridge", "runtime"]),
    );
    expect(context.hasExecApprovalClients?.("control-ui")).toBe(true);
    expect(
      context.getApprovalClientConnIds?.({
        excludeConnId: "control-ui",
        filter: (client) => client.connect.client.id === GATEWAY_CLIENT_IDS.IOS_APP,
      }),
    ).toEqual(new Set(["ios"]));
  });

  it("invalidateClientsForDevice sets the flag on matching clients without closing the socket", () => {
    const target = {
      connId: "conn-target",
      connect: { device: { id: "device-1" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const unrelated = {
      connId: "conn-unrelated",
      connect: { device: { id: "device-2" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const clients = new Set([target, unrelated]) as never;
    const invalidateDeviceTransports = vi.fn();
    const invalidateConnectionForPairingChange = vi.fn();

    const context = createGatewayRequestContext(
      makeContextParams({
        clients,
        invalidateDeviceTransports,
        nodeRegistry: { invalidateConnectionForPairingChange } as never,
      }),
    );
    context.invalidateClientsForDevice?.("device-1", { reason: "device-token-rotated" });

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe(
      "device-token-rotated",
    );
    expect(target.socket.close).not.toHaveBeenCalled();
    expect(invalidateConnectionForPairingChange).toHaveBeenCalledWith(
      "conn-target",
      "device-token-rotated",
    );

    expect((unrelated as { invalidated?: boolean }).invalidated).toBeUndefined();
    expect(unrelated.socket.close).not.toHaveBeenCalled();
    expect(invalidateDeviceTransports).toHaveBeenCalledWith("device-1", {
      reason: "device-token-rotated",
    });
  });

  it("disconnectClientsForDevice also marks the invalidated flag before closing", () => {
    const target = {
      connId: "conn-target",
      connect: { device: { id: "device-1" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const clients = new Set([target]) as never;
    const disconnectDeviceTransports = vi.fn();

    const context = createGatewayRequestContext(
      makeContextParams({ clients, disconnectDeviceTransports }),
    );
    context.disconnectClientsForDevice?.("device-1");

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe("device-removed");
    expect(target.socket.close).toHaveBeenCalledWith(4001, "device removed");
    expect(disconnectDeviceTransports).toHaveBeenCalledWith("device-1", undefined);
  });

  it("disconnects only clients authenticated as the reassigned durable profile", () => {
    const target = {
      ...makeGatewayClient({
        connId: "profile-target",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        scopes: ["operator.admin"],
      }),
      authenticatedUserProfile: {
        profileId: "profile-ada",
        displayName: "Ada",
        hasAvatar: false,
        updatedAt: 1,
      },
    };
    const unrelated = {
      ...makeGatewayClient({
        connId: "profile-unrelated",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserProfile: {
        profileId: "profile-grace",
        displayName: "Grace",
        hasAvatar: false,
        updatedAt: 1,
      },
    };
    const unidentified = makeGatewayClient({
      connId: "shared-secret",
      clientId: GATEWAY_CLIENT_IDS.CLI,
      scopes: ["operator.admin"],
    });
    const clients = new Set([target, unrelated, unidentified]) as never;
    const context = createGatewayRequestContext(makeContextParams({ clients }));
    target.socket.close.mockImplementation(() => {
      expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    });

    context.disconnectClientsForUserProfile?.("profile-ada");

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe(
      "operator-role-changed",
    );
    expect(target.socket.close).toHaveBeenCalledWith(4001, "operator role changed");
    expect(unrelated.socket.close).not.toHaveBeenCalled();
    expect(unidentified.socket.close).not.toHaveBeenCalled();
  });

  it("invalidateClientsForDevice filters by role when provided", () => {
    const primary = {
      connId: "conn-primary",
      connect: { device: { id: "device-1" }, role: "primary" },
      socket: { close: vi.fn() },
    };
    const secondary = {
      connId: "conn-secondary",
      connect: { device: { id: "device-1" }, role: "secondary" },
      socket: { close: vi.fn() },
    };
    const clients = new Set([primary, secondary]) as never;

    const context = createGatewayRequestContext(makeContextParams({ clients }));
    context.invalidateClientsForDevice?.("device-1", { role: "primary" });

    expect((primary as { invalidated?: boolean }).invalidated).toBe(true);
    expect((secondary as { invalidated?: boolean }).invalidated).toBeUndefined();
  });
});
