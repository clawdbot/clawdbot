/**
 * Shared HTTP fetch mock helpers for provider contract tests.
 */
import { afterEach, vi, type Mock } from "vitest";
import type {
  fetchProviderDownloadResponse,
  fetchProviderOperationResponse,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderRequestHeaders,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-http.js";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];
type FetchWithTimeoutGuardedParams = Parameters<typeof fetchWithTimeoutGuarded>;
type ResolveProviderRequestHeadersParams = Parameters<typeof resolveProviderRequestHeaders>[0];
type PollProviderOperationJsonParams = Parameters<typeof pollProviderOperationJson>[0];
type PostMultipartRequestParams = Parameters<typeof postMultipartRequest>[0];
type FetchProviderOperationResponseParams = Parameters<typeof fetchProviderOperationResponse>[0];
type FetchProviderDownloadResponseParams = Parameters<typeof fetchProviderDownloadResponse>[0];
type SanitizeConfiguredModelProviderRequestParams = Parameters<
  typeof sanitizeConfiguredModelProviderRequest
>[0];

type ResolveProviderHttpRequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: ReturnType<typeof resolveProviderHttpRequestConfig>["dispatcherPolicy"];
};

type AnyMock = Mock<(...args: unknown[]) => unknown>;

interface ProviderHttpMocks {
  resolveApiKeyForProviderMock: Mock<() => Promise<{ apiKey: string }>>;
  executeProviderOperationWithRetryMock: AnyMock;
  postJsonRequestMock: AnyMock;
  postMultipartRequestMock: AnyMock;
  fetchWithTimeoutMock: AnyMock;
  fetchWithTimeoutGuardedMock: AnyMock;
  pollProviderOperationJsonMock: AnyMock;
  assertOkOrThrowHttpErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  assertOkOrThrowProviderErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  readProviderJsonResponseMock: Mock<
    <T>(response: Response, label: string, opts?: { maxBytes?: number }) => Promise<T>
  >;
  sanitizeConfiguredModelProviderRequestMock: Mock<
    (
      request: SanitizeConfiguredModelProviderRequestParams,
    ) => SanitizeConfiguredModelProviderRequestParams
  >;
  resolveProviderHttpRequestConfigMock: Mock<
    (params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult
  >;
  resolveProviderRequestHeadersMock: Mock<
    (params: ResolveProviderRequestHeadersParams) => Record<string, string> | undefined
  >;
}

const providerHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  executeProviderOperationWithRetryMock: vi.fn(),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  fetchProviderOperationResponseMock: vi.fn(),
  fetchProviderDownloadResponseMock: vi.fn(),
  pollProviderOperationJsonMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  assertOkOrThrowProviderErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  readProviderJsonResponseMock: vi.fn(
    async <T>(response: Response, label: string, opts?: { maxBytes?: number }): Promise<T> => {
      const maxBytes = opts?.maxBytes ?? 16 * 1024 * 1024;
      if (!response.body) {
        try {
          return (await response.json()) as T;
        } catch (cause) {
          throw new Error(`${label}: malformed JSON response`, { cause });
        }
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error(`${label}: JSON response exceeds ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder().decode(body)) as T;
      } catch (cause) {
        throw new Error(`${label}: malformed JSON response`, { cause });
      }
    },
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn(
    (request: SanitizeConfiguredModelProviderRequestParams) => request,
  ),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork:
      (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
  resolveProviderRequestHeadersMock: vi.fn((params: ResolveProviderRequestHeadersParams) => {
    if (params.provider === "google") {
      return {
        ...params.defaultHeaders,
        "x-goog-api-client": "openclaw/test",
        ...params.callerHeaders,
      };
    }
    return params.callerHeaders ?? params.defaultHeaders;
  }),
}));

const providerHttpMockKeys = vi.hoisted(() => ({
  sanitizeConfiguredModelProviderRequest: "sanitizeConfiguredModelProviderRequest",
}));

providerHttpMocks.executeProviderOperationWithRetryMock.mockImplementation(
  async (params: {
    stage?: string;
    retry?: boolean | { attempts?: number; sleep?: (ms: number) => Promise<void> };
    operation: () => Promise<unknown>;
  }) => {
    const attempts =
      typeof params.retry === "object"
        ? Math.max(1, Math.round(params.retry.attempts ?? 1))
        : params.retry === false || params.stage === "create"
          ? 1
          : 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await params.operation();
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) {
          throw error;
        }
        if (typeof params.retry === "object") {
          await params.retry.sleep?.(0);
        }
      }
    }
    throw lastError;
  },
);

providerHttpMocks.fetchWithTimeoutGuardedMock.mockImplementation(
  async (...args: FetchWithTimeoutGuardedParams) => {
    const [url, init, timeoutMs, fetchFn] = args;
    const response = await providerHttpMocks.fetchWithTimeoutMock(
      url,
      init ?? {},
      timeoutMs ?? 60_000,
      fetchFn,
    );
    return {
      response,
      finalUrl: url,
      release: async () => {},
    };
  },
);

providerHttpMocks.postMultipartRequestMock.mockImplementation(
  async (params: PostMultipartRequestParams) => {
    const response = await providerHttpMocks.fetchWithTimeoutMock(
      params.url,
      {
        method: "POST",
        headers: params.headers,
        body: params.body,
      },
      params.timeoutMs ?? 60_000,
      params.fetchFn,
    );
    return {
      response,
      release: async () => {},
    };
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
      resolveMockProviderDownloadTimeoutMs(params),
      params.fetchFn,
    );
    await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
    return response;
  },
);

providerHttpMocks.pollProviderOperationJsonMock.mockImplementation(
  async (params: PollProviderOperationJsonParams) => {
    for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
      const headers = typeof params.headers === "function" ? params.headers() : params.headers;
      const response = await providerHttpMocks.fetchWithTimeoutMock(
        params.url,
        {
          method: "GET",
          headers,
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
  executeProviderOperationWithRetry: providerHttpMocks.executeProviderOperationWithRetryMock,
  fetchProviderDownloadResponse: providerHttpMocks.fetchProviderDownloadResponseMock,
  fetchProviderOperationResponse: providerHttpMocks.fetchProviderOperationResponseMock,
  fetchWithTimeout: providerHttpMocks.fetchWithTimeoutMock,
  fetchWithTimeoutGuarded: providerHttpMocks.fetchWithTimeoutGuardedMock,
  pollProviderOperationJson: providerHttpMocks.pollProviderOperationJsonMock,
  postJsonRequest: providerHttpMocks.postJsonRequestMock,
  postMultipartRequest: providerHttpMocks.postMultipartRequestMock,
  providerOperationRetryConfig: (_stage: string) => true,
  readProviderJsonResponse: providerHttpMocks.readProviderJsonResponseMock,
  resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    defaultTimeoutMs,
  resolveProviderHttpRequestConfig: providerHttpMocks.resolveProviderHttpRequestConfigMock,
  resolveProviderRequestHeaders: providerHttpMocks.resolveProviderRequestHeadersMock,
  [providerHttpMockKeys.sanitizeConfiguredModelProviderRequest]:
    providerHttpMocks.sanitizeConfiguredModelProviderRequestMock,
  waitProviderOperationPollInterval: async () => {},
}));

export function getProviderHttpMocks(): ProviderHttpMocks {
  return providerHttpMocks;
}

export function installProviderHttpMockCleanup(): void {
  afterEach(() => {
    providerHttpMocks.resolveApiKeyForProviderMock.mockClear();
    providerHttpMocks.executeProviderOperationWithRetryMock.mockClear();
    providerHttpMocks.postJsonRequestMock.mockReset();
    providerHttpMocks.postMultipartRequestMock.mockClear();
    providerHttpMocks.fetchWithTimeoutMock.mockReset();
    providerHttpMocks.fetchWithTimeoutGuardedMock.mockClear();
    providerHttpMocks.fetchProviderOperationResponseMock.mockClear();
    providerHttpMocks.fetchProviderDownloadResponseMock.mockClear();
    providerHttpMocks.pollProviderOperationJsonMock.mockClear();
    providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    providerHttpMocks.assertOkOrThrowProviderErrorMock.mockClear();
    providerHttpMocks.readProviderJsonResponseMock.mockClear();
    providerHttpMocks.sanitizeConfiguredModelProviderRequestMock.mockClear();
    providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
    providerHttpMocks.resolveProviderRequestHeadersMock.mockClear();
  });
}
