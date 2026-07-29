import { vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayEventFrame,
  GatewayEventListener,
} from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-page.ts";

type TestCustodianPage = HTMLElement & {
  onboarding: boolean;
  store: CustodianSessionStore;
  updateComplete: Promise<boolean>;
};

type ContextHarness = {
  context: ApplicationContext;
  setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  setGatewayToken: (token: string) => void;
  emitGatewayEvent: (event: Pick<GatewayEventFrame, "event" | "payload">) => void;
};

export function createContext(
  request: ReturnType<typeof vi.fn>,
  methods: string[] = ["openclaw.chat"],
  options: {
    agentsList?: ApplicationContext["agents"]["state"]["agentsList"];
  } = {},
): ContextHarness {
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const connection = {
    gatewayUrl: "ws://gateway.test/control",
    token: "",
    bootstrapToken: "",
    password: "",
  };
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection,
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents: (listener: GatewayEventListener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  const agentListeners = new Set<() => void>();
  const context = {
    gateway,
    agents: {
      state: {
        agentsList: options.agentsList ?? {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [{ id: "main", model: { primary: "openai/gpt-5.5" } }],
        },
      },
      subscribe: (listener: () => void) => {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
      refreshList: vi.fn(),
    },
    agentSelection: { state: { selectedId: "main" } },
    basePath: "",
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    context,
    setGatewaySnapshot: (patch) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    setGatewayToken: (value) => {
      const credentials = { token: value };
      connection.token = credentials.token;
    },
    emitGatewayEvent: (event) => {
      for (const listener of eventListeners) {
        listener(event as GatewayEventFrame);
      }
    },
  };
}

export async function mountPage(
  context: ApplicationContext,
  options: { onboarding?: boolean } = {},
): Promise<{
  page: TestCustodianPage;
  provider: ApplicationContextProvider;
}> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page") as TestCustodianPage;
  page.store = new CustodianSessionStore();
  page.onboarding = options.onboarding ?? true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}
