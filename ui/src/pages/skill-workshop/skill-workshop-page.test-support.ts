import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SkillWorkshopRevisionAdmissionOutcome } from "../../app/skill-workshop-revision-admissions.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { SkillWorkshopRouteData, SkillWorkshopState } from "./proposals.ts";

export type SkillWorkshopPageTestElement = HTMLElement & {
  context: ApplicationContext;
  data?: SkillWorkshopRouteData;
  state?: SkillWorkshopState;
  handleRevisionRequest: (
    instructions: string,
    proposal: SkillWorkshopProposal,
    proposalAgentId: string,
    expectedRevisionHash?: string,
  ) => Promise<SkillWorkshopRevisionAdmissionOutcome>;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

export function createRuntimeConfigStub(options?: {
  sourceConfig?: Record<string, unknown>;
  patch?: ReturnType<typeof vi.fn>;
}) {
  return {
    state: {
      configSnapshot: options?.sourceConfig
        ? { hash: "hash-1", sourceConfig: options.sourceConfig }
        : null,
      configLoading: false,
      lastError: null as string | null,
    },
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: options?.patch ?? vi.fn(async () => true),
    subscribe: () => () => undefined,
  };
}

export function createContext(
  request: ReturnType<typeof vi.fn>,
  options?: {
    gatewaySubscribe?: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
    agentSelectionSubscribe?: (listener: () => void) => () => void;
    methods?: string[];
    scopes?: string[];
    sessions?: ApplicationContext["sessions"];
    runtimeConfig?: ReturnType<typeof createRuntimeConfigStub>;
  },
): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(options?.methods ?? [], options?.scopes),
    assistantAgentId: "research",
    sessionKey: "global",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway: {
      snapshot,
      subscribe: options?.gatewaySubscribe ?? subscribe,
    },
    config: {
      current: { assistantIdentity: { name: "OpenClaw" } },
      subscribe,
    },
    agents: {
      state: { agentsList: null },
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research" },
      subscribe: options?.agentSelectionSubscribe ?? subscribe,
    },
    agentIdentity: {
      get: () => ({ agentId: "research", name: "Research" }),
      subscribe,
    },
    sessions: options?.sessions ?? { state: { result: null, loading: false } },
    runtimeConfig: options?.runtimeConfig ?? createRuntimeConfigStub(),
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
}
