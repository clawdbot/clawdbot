import type {
  pollProviderOperationJson,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { afterEach, vi } from "vitest";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];
type PollProviderOperationJsonParams = Parameters<typeof pollProviderOperationJson>[0];

const providerHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  pollProviderOperationJsonMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

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
  fetchWithTimeout: providerHttpMocks.fetchWithTimeoutMock,
  pollProviderOperationJson: providerHttpMocks.pollProviderOperationJsonMock,
  postJsonRequest: providerHttpMocks.postJsonRequestMock,
  resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    defaultTimeoutMs,
  resolveProviderHttpRequestConfig: providerHttpMocks.resolveProviderHttpRequestConfigMock,
  waitProviderOperationPollInterval: async () => {},
}));

export function getProviderHttpMocks() {
  return providerHttpMocks;
}

export function installProviderHttpMockCleanup(): void {
  afterEach(() => {
    providerHttpMocks.resolveApiKeyForProviderMock.mockClear();
    providerHttpMocks.postJsonRequestMock.mockReset();
    providerHttpMocks.fetchWithTimeoutMock.mockReset();
    providerHttpMocks.pollProviderOperationJsonMock.mockClear();
    providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
  });
}
