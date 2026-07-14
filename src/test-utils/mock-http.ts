import {
  fetch as undiciFetch,
  getGlobalDispatcher,
  MockAgent,
  type MockCallHistoryLog,
  setGlobalDispatcher,
} from "undici";
import { afterEach, beforeEach } from "vitest";

type MockHttpValueMatcher = string | RegExp | ((value: string) => boolean);
type MockHttpHeaderMatcher =
  | Record<string, MockHttpValueMatcher>
  | ((headers: Record<string, string>) => boolean);
type MockHttpHeaders = Record<string, string | string[]>;
type MockHttpBody = string | Buffer | Uint8Array | ArrayBuffer;

export type MockHttpReply =
  | {
      status?: number;
      body?: MockHttpBody;
      json?: never;
      headers?: MockHttpHeaders;
    }
  | {
      status?: number;
      body?: never;
      json: unknown;
      headers?: MockHttpHeaders;
    };

export type MockHttpInterceptor = {
  url: string | URL;
  method?: string;
  requestBody?: MockHttpValueMatcher;
  requestHeaders?: MockHttpHeaderMatcher;
  reply: MockHttpReply | Error;
  times?: number;
};

export type MockHttp = {
  setup: () => void;
  intercept: (params: MockHttpInterceptor) => void;
  requests: () => MockCallHistoryLog[];
  cleanup: () => Promise<void>;
};

function replyHeaders(reply: MockHttpReply): MockHttpHeaders {
  const headers = { ...reply.headers };
  if (
    "json" in reply &&
    !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")
  ) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

/** Creates an explicit lifecycle for tests that cannot use Vitest hooks. */
export function createMockHttp(): MockHttp {
  let agent: MockAgent | undefined;
  let previousDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined;
  let previousFetch: typeof globalThis.fetch | undefined;

  const requireAgent = (): MockAgent => {
    if (!agent) {
      throw new Error("Mock HTTP is not set up for this test");
    }
    return agent;
  };

  return {
    setup() {
      if (agent) {
        throw new Error("Mock HTTP is already set up for this test");
      }
      previousDispatcher = getGlobalDispatcher();
      previousFetch = globalThis.fetch;
      agent = new MockAgent({ enableCallHistory: true });
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
      // Node's DOM fetch type and root undici's fetch type use different iterator declarations.
      globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
    },
    intercept(params) {
      const currentAgent = requireAgent();
      const url = new URL(params.url);
      if (url.hash) {
        throw new Error(`Mock HTTP URLs cannot include fragments: ${url.toString()}`);
      }
      const interceptor = currentAgent.get(url.origin).intercept({
        path: `${url.pathname}${url.search}`,
        method: params.method ?? "GET",
        ...(params.requestBody === undefined ? {} : { body: params.requestBody }),
        ...(params.requestHeaders === undefined ? {} : { headers: params.requestHeaders }),
      });
      const scope =
        params.reply instanceof Error
          ? interceptor.replyWithError(params.reply)
          : interceptor.reply(
              params.reply.status ?? 200,
              "json" in params.reply ? JSON.stringify(params.reply.json) : params.reply.body,
              { headers: replyHeaders(params.reply) },
            );
      if (params.times !== undefined) {
        scope.times(params.times);
      }
    },
    requests() {
      return requireAgent().getCallHistory()?.calls() ?? [];
    },
    async cleanup() {
      const currentAgent = agent;
      const dispatcher = previousDispatcher;
      const fetch = previousFetch;
      agent = undefined;
      previousDispatcher = undefined;
      previousFetch = undefined;
      if (!currentAgent || !dispatcher || !fetch) {
        return;
      }
      try {
        currentAgent.assertNoPendingInterceptors();
      } finally {
        // Global dispatcher state outlives Vitest modules under --isolate=false.
        globalThis.fetch = fetch;
        setGlobalDispatcher(dispatcher);
        await currentAgent.close();
      }
    },
  };
}

/** Installs a fresh, network-disabled MockAgent for every test in the current suite. */
export function useMockHttp(): MockHttp {
  const mockHttp = createMockHttp();
  beforeEach(() => mockHttp.setup());
  afterEach(() => mockHttp.cleanup());
  return mockHttp;
}
