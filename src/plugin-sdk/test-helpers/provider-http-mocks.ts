import { afterEach, vi, type Mock } from "vitest";
import type {
  fetchProviderDownloadResponse,
  fetchProviderOperationResponse,
  pollProviderOperationJson,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-http.js";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];
type PollProviderOperationJsonParams = Parameters<typeof pollProviderOperationJson>[0];
type FetchProviderOperationResponseParams = Parameters<typeof fetchProviderOperationResponse>[0];
type FetchProviderDownloadResponseParams = Parameters<typeof fetchProviderDownloadResponse>[0];
type SanitizeConfiguredModelProviderRequestParams = Parameters<
  typeof sanitizeConfiguredModelProviderRequest
>[0];

type ResolveProviderHttpRequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: undefined;
};

type AnyMock = Mock<(...args: unknown[]) => unknown>;

interface ProviderHttpMocks {
  resolveApiKeyForProviderMock: Mock<() => Promise<{ apiKey: string }>>;
  postJsonRequestMock: AnyMock;
  fetchWithTimeoutMock: AnyMock;
  pollProviderOperationJsonMock: AnyMock;
  assertOkOrThrowHttpErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  assertOkOrThrowProviderErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  sanitizeConfiguredModelProviderRequestMock: Mock<
    (
      request: SanitizeConfiguredModelProviderRequestParams,
    ) => SanitizeConfiguredModelProviderRequestParams
  >;
  resolveProviderHttpRequestConfigMock: Mock<
    (params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult
  >;
}

const providerHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  fetchProviderOperationResponseMock: vi.fn(),
  fetchProviderDownloadResponseMock: vi.fn(),
  pollProviderOperationJsonMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  assertOkOrThrowProviderErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  sanitizeConfiguredModelProviderRequestMock: vi.fn(
    (request: SanitizeConfiguredModelProviderRequestParams) => request,
  ),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

function resolveMockProviderTimeoutMs(
  timeoutMs: FetchProviderOperationResponseParams["timeoutMs"],
) {
  return typeof timeoutMs === "function" ? timeoutMs() : (timeoutMs ?? 60_000);
}

providerHttpMocks.fetchProviderOperationResponseMock.mockImplementation(
  async (params: FetchProviderOperationResponseParams) => {
    const response = await providerHttpMocks.fetchWithTimeoutMock(
      params.url,
      params.init ?? {},
      resolveMockProviderTimeoutMs(params.timeoutMs),
      params.fetchFn,
    );
    if (params.requestFailedMessage) {
      await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
    }
    return response;
  },
);

providerHttpMocks.fetchProviderDownloadResponseMock.mockImplementation(
  async (params: FetchProviderDownloadResponseParams) => {
    const response = await providerHttpMocks.fetchWithTimeoutMock(
      params.url,
      params.init ?? {},
      resolveMockProviderTimeoutMs(params.timeoutMs),
      params.fetchFn,
    );
    await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
    return response;
  },
);

providerHttpMocks.pollProviderOperationJsonMock.mockImplementation(
  async (params: PollProviderOperationJsonParams) => {
    for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
      const response = await providerHttpMocks.fetchWithTimeoutMock(
        params.url,
        {
          method: "GET",
          headers: params.headers,
        },
        params.defaultTimeoutMs,
        params.fetchFn,
      );
      await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
      const payload = await response.json();
      if (params.isComplete(payload)) {
        return payload;
      }
      const failureMessage = params.getFailureMessage?.(payload);
      if (failureMessage) {
        throw new Error(failureMessage);
      }
    }
    throw new Error(params.timeoutMessage);
  },
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: providerHttpMocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: providerHttpMocks.assertOkOrThrowHttpErrorMock,
  assertOkOrThrowProviderError: providerHttpMocks.assertOkOrThrowProviderErrorMock,
  createProviderOperationDeadline: ({
    label,
    timeoutMs,
  }: {
    label: string;
    timeoutMs?: number;
  }) => ({
    label,
    timeoutMs,
  }),
  createProviderOperationTimeoutResolver:
    ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    () =>
      defaultTimeoutMs,
  executeProviderOperationWithRetry: async ({ operation }: { operation: () => Promise<unknown> }) =>
    await operation(),
  fetchProviderDownloadResponse: providerHttpMocks.fetchProviderDownloadResponseMock,
  fetchProviderOperationResponse: providerHttpMocks.fetchProviderOperationResponseMock,
  fetchWithTimeout: providerHttpMocks.fetchWithTimeoutMock,
  pollProviderOperationJson: providerHttpMocks.pollProviderOperationJsonMock,
  postJsonRequest: providerHttpMocks.postJsonRequestMock,
  providerOperationRetryConfig: (_stage: string) => true,
  resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    defaultTimeoutMs,
  resolveProviderHttpRequestConfig: providerHttpMocks.resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequest:
    providerHttpMocks.sanitizeConfiguredModelProviderRequestMock,
  waitProviderOperationPollInterval: async () => {},
}));

export function getProviderHttpMocks(): ProviderHttpMocks {
  return providerHttpMocks;
}

export function installProviderHttpMockCleanup(): void {
  afterEach(() => {
    providerHttpMocks.resolveApiKeyForProviderMock.mockClear();
    providerHttpMocks.postJsonRequestMock.mockReset();
    providerHttpMocks.fetchWithTimeoutMock.mockReset();
    providerHttpMocks.fetchProviderOperationResponseMock.mockClear();
    providerHttpMocks.fetchProviderDownloadResponseMock.mockClear();
    providerHttpMocks.pollProviderOperationJsonMock.mockClear();
    providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    providerHttpMocks.assertOkOrThrowProviderErrorMock.mockClear();
    providerHttpMocks.sanitizeConfiguredModelProviderRequestMock.mockClear();
    providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
  });
}
