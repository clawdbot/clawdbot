import type { resolveProviderHttpRequestConfig } from "openclaw/plugin-sdk/provider-http";
import { afterEach, vi } from "vitest";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];

const providerHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

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
    providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
  });
}
