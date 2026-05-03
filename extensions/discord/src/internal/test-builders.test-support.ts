import { ComponentType, InteractionType } from "discord-api-types/v10";
import { vi, type Mock } from "vitest";
import { Client, type ClientOptions } from "./client.js";
import type { BaseCommand } from "./commands.js";
import type { RawInteraction } from "./interactions.js";
import type { QueuedRequest, RequestClient, RequestData } from "./rest.js";

type RestMock = Partial<Record<"get" | "post" | "patch" | "put" | "delete", Mock>>;
type RestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type RawInteractionOverrides = Omit<Partial<RawInteraction>, "data" | "type"> &
  Pick<RawInteraction, "id" | "token"> & {
    data?: Record<string, unknown>;
  };

type FakeRestCall = {
  method: RestMethod;
  path: string;
  data?: RequestData;
  query?: QueuedRequest["query"];
};

type FakeRestClient = RequestClient & {
  calls: FakeRestCall[];
  enqueueResponse: (value: unknown) => void;
};

export function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve: resolve! };
}

export function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
  });
}

export function createAbortableFetchMock() {
  let receivedSignal: AbortSignal | undefined;
  const fetch = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        receivedSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
  return {
    fetch,
    get receivedSignal() {
      return receivedSignal;
    },
  };
}

export function createInternalTestClient(
  commands: BaseCommand[] = [],
  options?: Partial<ClientOptions>,
): Client {
  return new Client(
    {
      baseUrl: "http://localhost",
      clientId: "app1",
      publicKey: "public",
      token: "token",
      ...options,
    },
    { commands },
  );
}

function createRestMock(overrides: RestMock = {}): RestMock & RequestClient {
  return {
    get: vi.fn(async () => undefined),
    post: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...overrides,
  } as RestMock & RequestClient;
}

export function attachRestMock(client: Client, rest: RestMock): RestMock & RequestClient {
  const mock = createRestMock(rest);
  client.rest = mock;
  return mock;
}

export function createFakeRestClient(responses: unknown[] = []): FakeRestClient {
  const calls: FakeRestCall[] = [];
  const queued = [...responses];
  const request = async (
    method: RestMethod,
    path: string,
    data?: RequestData,
    query?: QueuedRequest["query"],
  ) => {
    calls.push({ method, path, data, query });
    return queued.shift();
  };
  return {
    calls,
    enqueueResponse: (value: unknown) => {
      queued.push(value);
    },
    get: async (path, query) => await request("GET", path, undefined, query),
    post: async (path, data, query) => await request("POST", path, data, query),
    patch: async (path, data, query) => await request("PATCH", path, data, query),
    put: async (path, data, query) => await request("PUT", path, data, query),
    delete: async (path, data, query) => await request("DELETE", path, data, query),
  } as FakeRestClient;
}

export function createInternalInteractionPayload(
  overrides: Partial<RawInteraction> & Pick<RawInteraction, "id" | "token">,
): RawInteraction {
  return {
    application_id: "app1",
    type: InteractionType.ApplicationCommand,
    version: 1,
    data: {
      id: "command1",
      name: "test",
      type: 1,
    },
    ...overrides,
  } as unknown as RawInteraction;
}

export function createInternalComponentInteractionPayload(
  overrides: RawInteractionOverrides,
): RawInteraction {
  const { data, ...rest } = overrides;
  return {
    application_id: "app1",
    version: 1,
    data: {
      component_type: ComponentType.Button,
      custom_id: "component1",
      ...data,
    },
    ...rest,
    type: InteractionType.MessageComponent,
  } as unknown as RawInteraction;
}

export function createInternalModalInteractionPayload(
  overrides: RawInteractionOverrides,
): RawInteraction {
  const { data, ...rest } = overrides;
  return {
    application_id: "app1",
    version: 1,
    data: {
      custom_id: "modal1",
      components: [],
      ...data,
    },
    ...rest,
    type: InteractionType.ModalSubmit,
  } as unknown as RawInteraction;
}
