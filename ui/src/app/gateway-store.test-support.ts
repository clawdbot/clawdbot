// Shared harness for the gateway-store test suites (base + restart split);
// keeps the fake client and store factory in one place under the max-lines cap.
import { vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayEventFrame,
  GatewayHelloOk,
} from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

export const GATEWAY_STORE_TEST_HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

export function createGatewayEvent(
  event = "chat",
  payload: unknown = {},
  seq = 1,
): GatewayEventFrame {
  return {
    type: "event",
    event,
    payload,
    seq,
    stateVersion: { presence: seq, health: seq },
  };
}

class FakeGatewayClient {
  started = 0;
  stopped = 0;
  readonly instanceId: string;

  constructor(readonly opts: GatewayBrowserClientOptions) {
    this.instanceId = opts.instanceId ?? "";
  }

  start() {
    this.started += 1;
  }

  stop() {
    this.stopped += 1;
  }

  request = vi.fn(
    (_method: string, _params: unknown): Promise<unknown> =>
      Promise.reject(new Error("unexpected gateway request")),
  );

  addEventListener() {
    return () => {};
  }
}

export function createGatewayStoreTestStore(
  params: {
    settings?: ReturnType<typeof loadSettings>;
    persistDefaultConnectionSettings?: boolean;
    resourceBasePath?: string;
    clientOptions?: Pick<
      GatewayBrowserClientOptions,
      "clientName" | "mode" | "platform" | "deviceFamily" | "instanceId" | "scopes"
    >;
  } = {},
) {
  const clients: FakeGatewayClient[] = [];
  const gateway = createApplicationGateway(
    params.settings ?? loadSettings(),
    "",
    "",
    (opts) => {
      const client = new FakeGatewayClient(opts);
      clients.push(client);
      return client as unknown as GatewayBrowserClient;
    },
    {
      persistDefaultConnectionSettings: params.persistDefaultConnectionSettings,
      resourceBasePath: params.resourceBasePath,
      clientOptions: params.clientOptions,
    },
  );
  const current = () => {
    const client = clients.at(-1);
    if (!client) {
      throw new Error("expected a gateway client");
    }
    return client;
  };
  return { gateway, clients, current };
}

export function stubGatewayStoreTestGlobals() {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  vi.stubGlobal("location", {
    protocol: "http:",
    host: "127.0.0.1:18789",
    hostname: "127.0.0.1",
    origin: "http://127.0.0.1:18789",
    pathname: "/",
    href: "http://127.0.0.1:18789/",
  } as Location);
}
