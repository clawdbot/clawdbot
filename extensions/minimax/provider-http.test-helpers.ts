import type { resolveProviderHttpRequestConfig } from "openclaw/plugin-sdk/provider-http";
import { afterEach, vi } from "vitest";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];

const minimaxProviderHttpMocks = vi.hoisted(() => ({
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
  fetchWithTimeout: minimaxProviderHttpMocks.fetchWithTimeoutMock,
  postJsonRequest: minimaxProviderHttpMocks.postJsonRequestMock,
  resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    defaultTimeoutMs,
  resolveProviderHttpRequestConfig: minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock,
  waitProviderOperationPollInterval: async () => {},
}));

export function getMinimaxProviderHttpMocks() {
  return minimaxProviderHttpMocks;
}

export function installMinimaxProviderHttpMockCleanup(): void {
  afterEach(() => {
    minimaxProviderHttpMocks.resolveApiKeyForProviderMock.mockClear();
    minimaxProviderHttpMocks.postJsonRequestMock.mockReset();
    minimaxProviderHttpMocks.fetchWithTimeoutMock.mockReset();
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
