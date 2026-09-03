import { vi } from "vitest";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionRouteData } from "./location.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

type FixtureOptions = {
  takePreparedTitle?: () => string | undefined;
  phase?: "connected" | "connecting";
  agents?: unknown[];
  methods?: string[];
  scopes?: string[];
  selfUser?: { id: string };
  data?: NewSessionRouteData;
  request?: (method: string) => Promise<unknown>;
};

export function createDraftFixture(options: FixtureOptions = {}) {
  const request = vi.fn((method: string) => {
    if (options.request) {
      return options.request(method);
    }
    return Promise.resolve({});
  });
  const client = { recoveryScope: "principal-a", recoveryScopeReady: true, request };
  const phase = options.phase ?? "connected";
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.example" },
      snapshot: {
        phase,
        client: phase === "connected" ? client : null,
        sessionKey: "",
        ...(options.selfUser ? { selfUser: options.selfUser } : {}),
        hello:
          phase === "connected"
            ? {
                server: { bootId: "gateway-boot-a" },
                auth: {
                  recoveryScope: client.recoveryScope,
                  role: "operator",
                  scopes: options.scopes ?? ["operator.read", "operator.write"],
                },
                features: { methods: options.methods ?? ["sessions.create"] },
              }
            : null,
      },
      setSessionKey: vi.fn(),
    },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          agents: options.agents ?? [
            {
              id: "main",
              workspace: "/workspace",
              workspaceGit: false,
              model: { primary: "openai/gpt-5.6-luna" },
            },
          ],
        },
      },
    },
    sessions: { state: { result: null }, createResult: vi.fn() },
    placementStartup: {
      get: vi.fn(() => undefined),
      hasPendingTurn: vi.fn(() => false),
    },
    chatSubmissions: createChatSubmissions(),
    agentSelection: { state: { selectedId: "main" }, set: vi.fn() },
    config: { current: { cliAgentsEnabled: true, terminalEnabled: true } },
    navigateAndWait: vi.fn(async () => undefined),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
  vi.mocked(context.gateway.setSessionKey).mockImplementation((sessionKey) => {
    context.gateway.snapshot.sessionKey = sessionKey;
  });
  const host = new TestReactiveControllerHost();
  const gateway = new DraftGatewayState(
    host,
    () => ({
      context,
      data: options.data,
      isConnected: phase === "connected",
      isAdmin: place?.isAdmin() ?? false,
      canStartAsDraft: flow?.capabilities.canStartAsDraft(context) ?? false,
      visibility: flow?.visibility ?? "normal",
      cloudProfileId: place?.cloudProfileId ?? "",
      pendingPlacement: flow?.pendingPlacement ?? {
        sessionKey: "",
        gatewayUrl: "",
        recoveryScope: "",
      },
      agentsHydrated: place?.agentsHydrated ?? false,
      runtimeId: place?.devicePlacementRuntime()?.id ?? "",
    }),
    {
      requestUpdate: vi.fn(),
      updateComplete: () => Promise.resolve(),
      onInvalidate: vi.fn(),
      onVisibilityRetired: () => flow?.setVisibility("normal"),
      onCloudProfileCleared: () => place?.clearCloudProfile(),
      onCloudState: (error) => flow?.setError(error),
      onPendingPlacementReset: () => flow?.releasePendingPlacementOwner(),
      onRecoveryReady: (gatewayUrl, recoveryScope) =>
        flow?.restorePendingPlacementRecovery(gatewayUrl, recoveryScope),
      onAdoptAgentDefaults: () => place?.adoptAgentDefaults(),
    },
  );
  const browser = new DraftPlaceBrowser(
    host,
    gateway,
    () => ({
      context,
      isAdmin: place?.isAdmin() ?? false,
    }),
    {
      requestUpdate: vi.fn(),
      onProjectMissing: () => place?.clearProjectSelection(),
      onSelectProject: (projectId) => place?.selectProjectId(projectId),
      onApprovedListing: (listing) => place?.recordGatewayApprovedListing(listing),
      querySelector: () => null,
      activeElement: () => null,
      body: () => null,
    },
  );
  const place = new DraftPlaceState(
    gateway,
    browser,
    () => ({
      context,
      data: options.data,
      submitting: flow?.submitting ?? false,
      pendingPlacementSessionKey: flow?.pendingPlacement.sessionKey ?? "",
    }),
    {
      requestUpdate: vi.fn(),
      onError: (error) => flow?.setError(error),
      onClearError: (error) => flow?.clearErrorIf(error),
    },
  );
  const requestUpdate = vi.fn();
  const flow = new DraftSubmissionFlow(
    gateway,
    place,
    () => ({ context, data: options.data, isConnected: phase === "connected" }),
    { requestUpdate, closeTransientUi: vi.fn(), takePreparedTitle: options.takePreparedTitle },
  );
  gateway.synchronize(context.gateway);
  place.setAgentsHydrated(true);
  place.adoptAgentDefaults();
  return { capabilities: flow.capabilities, context, flow, gateway, place, request, requestUpdate };
}
