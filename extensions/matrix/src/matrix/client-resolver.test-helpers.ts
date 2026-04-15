import { expect, vi, type Mock } from "vitest";
import type { MatrixClient } from "./sdk.js";

type MatrixClientResolverMocks = {
  loadConfigMock: Mock<() => unknown>;
  getMatrixRuntimeMock: Mock<() => unknown>;
  getActiveMatrixClientMock: Mock<(...args: unknown[]) => MatrixClient | null>;
  acquireSharedMatrixClientMock: Mock<(...args: unknown[]) => Promise<MatrixClient>>;
  releaseSharedClientInstanceMock: Mock<(...args: unknown[]) => Promise<boolean>>;
  isBunRuntimeMock: Mock<() => boolean>;
  resolveMatrixAuthContextMock: Mock<
    (params: { cfg: unknown; accountId?: string | null }) => unknown
  >;
};

export const matrixClientResolverMocks: MatrixClientResolverMocks = {
  loadConfigMock: vi.fn(() => ({})),
  getMatrixRuntimeMock: vi.fn(),
  getActiveMatrixClientMock: vi.fn(),
  acquireSharedMatrixClientMock: vi.fn(),
  releaseSharedClientInstanceMock: vi.fn(),
  isBunRuntimeMock: vi.fn(() => false),
  resolveMatrixAuthContextMock: vi.fn(),
};

export function createMockMatrixClient(): MatrixClient {
  return {
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
  } as unknown as MatrixClient;
}

export function primeMatrixClientResolverMocks(params?: {
  cfg?: unknown;
  accountId?: string;
  resolved?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  client?: MatrixClient;
}): MatrixClient {
  const {
    loadConfigMock,
    getMatrixRuntimeMock,
    getActiveMatrixClientMock,
    acquireSharedMatrixClientMock,
    releaseSharedClientInstanceMock,
    isBunRuntimeMock,
    resolveMatrixAuthContextMock,
  } = matrixClientResolverMocks;

  const cfg = params?.cfg ?? {};
  const accountId = params?.accountId ?? "default";
  const defaultResolved = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    password: undefined,
    deviceId: "DEVICE123",
    encryption: false,
  };
  const client = params?.client ?? createMockMatrixClient();

  vi.clearAllMocks();
  loadConfigMock.mockReturnValue(cfg);
  getMatrixRuntimeMock.mockReturnValue({
    config: {
      loadConfig: loadConfigMock,
    },
  });
  getActiveMatrixClientMock.mockReturnValue(null);
  isBunRuntimeMock.mockReturnValue(false);
  releaseSharedClientInstanceMock.mockReset().mockResolvedValue(true);
  resolveMatrixAuthContextMock.mockImplementation(
    ({
      cfg: explicitCfg,
      accountId: explicitAccountId,
    }: {
      cfg: unknown;
      accountId?: string | null;
    }) => ({
      cfg: explicitCfg,
      env: process.env,
      accountId: explicitAccountId ?? accountId,
      resolved: {
        ...defaultResolved,
        ...params?.resolved,
      },
    }),
  );
  acquireSharedMatrixClientMock.mockResolvedValue(client);

  return client;
}

export async function expectOneOffSharedMatrixClient(params?: {
  cfg?: unknown;
  accountId?: string;
  timeoutMs?: number;
  prepareForOneOffCalls?: number;
  startCalls?: number;
  releaseMode?: "persist" | "stop";
}) {
  const {
    getActiveMatrixClientMock,
    acquireSharedMatrixClientMock,
    releaseSharedClientInstanceMock,
  } = matrixClientResolverMocks;
  const accountId = params?.accountId ?? "default";
  const prepareForOneOffCalls = params?.prepareForOneOffCalls ?? 1;
  const startCalls = params?.startCalls ?? 0;
  const releaseMode = params?.releaseMode ?? "stop";

  expect(getActiveMatrixClientMock).toHaveBeenCalledWith(accountId);
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledTimes(1);
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params?.cfg ?? {},
    timeoutMs: params?.timeoutMs,
    accountId,
    startClient: false,
  });

  const sharedClient = await acquireSharedMatrixClientMock.mock.results[0]?.value;
  expect(sharedClient.prepareForOneOff).toHaveBeenCalledTimes(prepareForOneOffCalls);
  expect(sharedClient.start).toHaveBeenCalledTimes(startCalls);
  expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, releaseMode);

  return sharedClient;
}

export function expectExplicitMatrixClientConfig(params: { cfg: unknown; accountId?: string }) {
  const { getMatrixRuntimeMock, resolveMatrixAuthContextMock, acquireSharedMatrixClientMock } =
    matrixClientResolverMocks;
  const accountId = params.accountId ?? "default";

  expect(getMatrixRuntimeMock).not.toHaveBeenCalled();
  expect(resolveMatrixAuthContextMock).toHaveBeenCalledWith({
    cfg: params.cfg,
    accountId,
  });
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params.cfg,
    timeoutMs: undefined,
    accountId,
    startClient: false,
  });
}
