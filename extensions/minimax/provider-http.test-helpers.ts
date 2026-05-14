import type {
  fetchProviderDownloadResponse,
  fetchProviderOperationResponse,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { afterEach, vi, type Mock } from "vitest";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];
type FetchProviderOperationResponseParams = Parameters<typeof fetchProviderOperationResponse>[0];
type FetchProviderDownloadResponseParams = Parameters<typeof fetchProviderDownloadResponse>[0];

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
  fetchWithTimeoutMock: AnyMock;
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
  fetchWithTimeoutMock: vi.fn(),
  fetchProviderOperationResponseMock: vi.fn(),
  fetchProviderDownloadResponseMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

function resolveMockProviderTimeoutMs(
  timeoutMs: FetchProviderOperationResponseParams["timeoutMs"],
) {
  return typeof timeoutMs === "function" ? timeoutMs() : (timeoutMs ?? 60_000);
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
      resolveMockProviderTimeoutMs(params.timeoutMs),
      params.fetchFn,
    );
    await minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock(
      response,
      params.requestFailedMessage,
    );
    return response;
  },
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: minimaxProviderHttpMocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock,
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
  fetchProviderDownloadResponse: minimaxProviderHttpMocks.fetchProviderDownloadResponseMock,
  fetchProviderOperationResponse: minimaxProviderHttpMocks.fetchProviderOperationResponseMock,
  fetchWithTimeout: minimaxProviderHttpMocks.fetchWithTimeoutMock,
  postJsonRequest: minimaxProviderHttpMocks.postJsonRequestMock,
  resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    defaultTimeoutMs,
  resolveProviderHttpRequestConfig: minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock,
  waitProviderOperationPollInterval: async () => {},
}));

export function getMinimaxProviderHttpMocks(): MinimaxProviderHttpMocks {
  return minimaxProviderHttpMocks;
}

export function installMinimaxProviderHttpMockCleanup(): void {
  afterEach(() => {
    minimaxProviderHttpMocks.resolveApiKeyForProviderMock.mockClear();
    minimaxProviderHttpMocks.postJsonRequestMock.mockReset();
    minimaxProviderHttpMocks.fetchWithTimeoutMock.mockReset();
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
