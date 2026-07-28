// Minimax provider module implements model/runtime integration.
import type {
  executeProviderOperationWithRetry,
  fetchProviderDownloadResponse,
  fetchProviderOperationResponse,
  fetchWithTimeoutGuarded,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { afterEach, vi, type Mock } from "vitest";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];
type FetchProviderOperationResponseParams = Parameters<typeof fetchProviderOperationResponse>[0];
type FetchProviderDownloadResponseParams = Parameters<typeof fetchProviderDownloadResponse>[0];
type FetchWithTimeoutGuardedParams = Parameters<typeof fetchWithTimeoutGuarded>;
type ExecuteProviderOperationWithRetryParams = Parameters<
  typeof executeProviderOperationWithRetry
>[0];

type ResolveProviderHttpRequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: undefined;
};

type AnyMock = Mock<(...args: any[]) => any>;

interface MinimaxProviderHttpMocks {
  resolveApiKeyForProviderMock: Mock<() => Promise<{ apiKey: string }>>;
  postJsonRequestMock: AnyMock;
  executeProviderOperationWithRetryMock: AnyMock;
  fetchWithTimeoutMock: AnyMock;
  fetchWithTimeoutGuardedMock: AnyMock;
  fetchProviderOperationResponseMock: AnyMock;
  fetchProviderDownloadResponseMock: AnyMock;
  assertOkOrThrowHttpErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  resolveProviderHttpRequestConfigMock: Mock<
    (params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult
  >;
}

const minimaxProviderHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  postJsonRequestMock: vi.fn(),
  executeProviderOperationWithRetryMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  fetchProviderOperationResponseMock: vi.fn(),
  fetchProviderDownloadResponseMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => {
    const request = params.request as
      | {
          allowPrivateNetwork?: boolean;
          headers?: Record<string, string>;
        }
      | undefined;
    const headers = new Headers(params.defaultHeaders);
    for (const [key, value] of Object.entries(request?.headers ?? {})) {
      headers.set(key, value);
    }
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: request?.allowPrivateNetwork === true,
      headers,
      dispatcherPolicy: undefined,
    };
  }),
}));

minimaxProviderHttpMocks.executeProviderOperationWithRetryMock.mockImplementation(
  async (params: ExecuteProviderOperationWithRetryParams) => {
    const attempts = params.retry === false || params.stage === "create" ? 1 : 2;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await params.operation();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  },
);

function resolveMockProviderTimeoutMs(
  timeoutMs: FetchProviderOperationResponseParams["timeoutMs"],
) {
  return typeof timeoutMs === "function" ? timeoutMs() : (timeoutMs ?? 60_000);
}

function resolveMockProviderDownloadTimeoutMs(params: FetchProviderDownloadResponseParams) {
  if (!params.deadline) {
    return resolveMockProviderTimeoutMs(params.timeoutMs);
  }
  return params.deadline.deadlineAtMs === undefined
    ? (params.deadline.timeoutMs ?? 60_000)
    : Math.max(1, params.deadline.deadlineAtMs - Date.now());
}

minimaxProviderHttpMocks.fetchProviderOperationResponseMock.mockImplementation(
  async (params: FetchProviderOperationResponseParams) => {
    const response = await minimaxProviderHttpMocks.fetchWithTimeoutMock(
      params.url,
      params.init ?? {},
      resolveMockProviderTimeoutMs(params.timeoutMs),
      params.fetchFn,
    );
    if (params.requestFailedMessage) {
      await minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock(
        response,
        params.requestFailedMessage,
      );
    }
    return response;
  },
);

minimaxProviderHttpMocks.fetchProviderDownloadResponseMock.mockImplementation(
  async (params: FetchProviderDownloadResponseParams) => {
    const response = await minimaxProviderHttpMocks.fetchWithTimeoutMock(
      params.url,
      params.init ?? {},
      resolveMockProviderDownloadTimeoutMs(params),
      params.fetchFn,
    );
    await minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock(
      response,
      params.requestFailedMessage,
    );
    return response;
  },
);

minimaxProviderHttpMocks.fetchWithTimeoutGuardedMock.mockImplementation(
  async (
    url: FetchWithTimeoutGuardedParams[0],
    init: FetchWithTimeoutGuardedParams[1],
    timeoutMs: FetchWithTimeoutGuardedParams[2],
    fetchFn: FetchWithTimeoutGuardedParams[3],
  ) => ({
    response: await minimaxProviderHttpMocks.fetchWithTimeoutMock(
      url,
      init,
      timeoutMs ?? 60_000,
      fetchFn,
    ),
    finalUrl: url,
    release: vi.fn(async () => {}),
  }),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: minimaxProviderHttpMocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    assertOkOrThrowHttpError: minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock,
    createProviderOperationDeadline: ({
      label,
      timeoutMs,
    }: {
      label: string;
      timeoutMs?: number | (() => number);
    }) => {
      const resolvedTimeoutMs = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
      return {
        label,
        timeoutMs: resolvedTimeoutMs,
        deadlineAtMs:
          typeof resolvedTimeoutMs === "number" ? Date.now() + resolvedTimeoutMs : undefined,
      };
    },
    createProviderOperationTimeoutResolver:
      ({
        deadline,
        defaultTimeoutMs,
      }: {
        deadline: { deadlineAtMs?: number; label: string; timeoutMs?: number };
        defaultTimeoutMs: number;
      }) =>
      () => {
        if (typeof deadline.deadlineAtMs !== "number") {
          return defaultTimeoutMs;
        }
        const remainingMs = deadline.deadlineAtMs - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`${deadline.label} timed out after ${deadline.timeoutMs}ms`);
        }
        return Math.min(defaultTimeoutMs, remainingMs);
      },
    executeProviderOperationWithRetry:
      minimaxProviderHttpMocks.executeProviderOperationWithRetryMock,
    fetchProviderDownloadResponse: minimaxProviderHttpMocks.fetchProviderDownloadResponseMock,
    fetchProviderOperationResponse: minimaxProviderHttpMocks.fetchProviderOperationResponseMock,
    fetchWithTimeoutGuarded: minimaxProviderHttpMocks.fetchWithTimeoutGuardedMock,
    fetchWithTimeout: minimaxProviderHttpMocks.fetchWithTimeoutMock,
    postJsonRequest: minimaxProviderHttpMocks.postJsonRequestMock,
    readProviderJsonResponse: actual.readProviderJsonResponse,
    resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
      defaultTimeoutMs,
    resolveProviderHttpRequestConfig: minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock,
    sanitizeConfiguredModelProviderRequest: actual.sanitizeConfiguredModelProviderRequest,
    waitProviderOperationPollInterval: async () => {},
  };
});

export function getMinimaxProviderHttpMocks(): MinimaxProviderHttpMocks {
  return minimaxProviderHttpMocks;
}

export function installMinimaxProviderHttpMockCleanup(): void {
  afterEach(() => {
    minimaxProviderHttpMocks.resolveApiKeyForProviderMock.mockClear();
    minimaxProviderHttpMocks.postJsonRequestMock.mockReset();
    minimaxProviderHttpMocks.executeProviderOperationWithRetryMock.mockClear();
    minimaxProviderHttpMocks.fetchWithTimeoutMock.mockReset();
    minimaxProviderHttpMocks.fetchWithTimeoutGuardedMock.mockClear();
    minimaxProviderHttpMocks.fetchProviderOperationResponseMock.mockClear();
    minimaxProviderHttpMocks.fetchProviderDownloadResponseMock.mockClear();
    minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
  });
}

export function loadMinimaxMusicGenerationProviderModule() {
  return import("./music-generation-provider.js");
}

export function loadMinimaxVideoGenerationProviderModule() {
  return import("./video-generation-provider.js");
}
