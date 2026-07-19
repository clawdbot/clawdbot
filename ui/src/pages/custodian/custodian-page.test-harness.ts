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
import "./custodian-page.ts";

type TestCustodianPage = HTMLElement & {
  onboarding: boolean;
  updateComplete: Promise<boolean>;
};

type ContextHarness = {
  context: ApplicationContext;
  setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  setGatewayUrl: (gatewayUrl: string) => void;
  setGatewayToken: (token: string) => void;
  setGatewayBootstrapToken: (bootstrapToken: string) => void;
  setGatewayDeviceToken: (deviceToken: string) => void;
  emitGatewayEvent: (event: Pick<GatewayEventFrame, "event" | "payload">) => void;
};

export function createContext(
  request: ReturnType<typeof vi.fn>,
  methods: string[] = ["openclaw.chat"],
): ContextHarness {
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
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
  const context = {
    gateway,
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
    setGatewayUrl: (gatewayUrl) => {
      connection.gatewayUrl = gatewayUrl;
    },
    setGatewayToken: (token: string) => {
      connection.token = token;
    },
    setGatewayBootstrapToken: (value: string) => {
      connection.bootstrapToken = value;
    },
    setGatewayDeviceToken: (deviceToken: string) => {
      snapshot = {
        ...snapshot,
        hello: snapshot.hello
          ? { ...snapshot.hello, auth: { ...snapshot.hello.auth, deviceToken } }
          : snapshot.hello,
      };
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
  page.onboarding = options.onboarding ?? true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}
