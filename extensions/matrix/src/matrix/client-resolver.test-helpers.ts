// Matrix helper module supports client resolver helpers behavior.
import { expect, vi, type Mock } from "vitest";
import type { SharedMatrixClientLease } from "./client/shared.js";
import type { MatrixClient } from "./sdk.js";

type MatrixClientResolverMocks = {
  loadConfigMock: Mock<() => unknown>;
  getMatrixRuntimeMock: Mock<() => unknown>;
  acquireSharedMatrixClientMock: Mock<(...args: unknown[]) => Promise<SharedMatrixClientLease>>;
  sharedLeaseReleaseMock: Mock<(...args: unknown[]) => Promise<void>>;
  sharedLeaseStartMock: Mock<(...args: unknown[]) => Promise<void>>;
  resolveMatrixAuthContextMock: Mock<
    (params: { cfg: unknown; accountId?: string | null }) => unknown
  >;
};

export const matrixClientResolverMocks: MatrixClientResolverMocks = {
  loadConfigMock: vi.fn(() => ({})),
  getMatrixRuntimeMock: vi.fn(),
  acquireSharedMatrixClientMock: vi.fn(),
  sharedLeaseReleaseMock: vi.fn(),
  sharedLeaseStartMock: vi.fn(),
  resolveMatrixAuthContextMock: vi.fn(),
};

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => {
      if (cfg) {
        return cfg;
      }
      return matrixClientResolverMocks.loadConfigMock();
    }),
  };
});

export function createMockMatrixClient(): MatrixClient {
  return {
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
    stopWithoutPersist: vi.fn(async () => undefined),
  } as unknown as MatrixClient;
}

export function setAcquiredMatrixClient(client: MatrixClient): SharedMatrixClientLease {
  const { acquireSharedMatrixClientMock, sharedLeaseReleaseMock, sharedLeaseStartMock } =
    matrixClientResolverMocks;
  sharedLeaseStartMock.mockImplementation(async () => {
    await client.start();
  });
  const lease: SharedMatrixClientLease = {
    abortSignal: new AbortController().signal,
    client,
    role: "transient",
    registerMonitorRetirement: vi.fn(),
    start: sharedLeaseStartMock,
    release: sharedLeaseReleaseMock,
  };
  acquireSharedMatrixClientMock.mockResolvedValue(lease);
  return lease;
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
    acquireSharedMatrixClientMock,
    sharedLeaseReleaseMock,
    sharedLeaseStartMock,
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
      current: loadConfigMock,
    },
  });
  sharedLeaseReleaseMock.mockReset().mockResolvedValue(undefined);
  sharedLeaseStartMock.mockReset();
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
  acquireSharedMatrixClientMock.mockReset();
  setAcquiredMatrixClient(client);

  return client;
}

export async function expectOneOffSharedMatrixClient(params?: {
  cfg?: unknown;
  accountId?: string;
  timeoutMs?: number;
  prepareForOneOffCalls?: number;
  startCalls?: number;
  releaseMode?: "persist" | "stop" | "discard";
}) {
  const { acquireSharedMatrixClientMock, sharedLeaseReleaseMock } = matrixClientResolverMocks;
  const accountId = params?.accountId ?? "default";
  const prepareForOneOffCalls = params?.prepareForOneOffCalls ?? 1;
  const startCalls = params?.startCalls ?? 0;
  const releaseMode = params?.releaseMode ?? "stop";

  expect(acquireSharedMatrixClientMock).toHaveBeenCalledTimes(1);
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params?.cfg ?? {},
    timeoutMs: params?.timeoutMs,
    accountId,
    startClient: false,
    role: "transient",
  });

  const lease = await acquireSharedMatrixClientMock.mock.results[0]?.value;
  expect(lease.client.prepareForOneOff).toHaveBeenCalledTimes(prepareForOneOffCalls);
  expect(lease.client.start).toHaveBeenCalledTimes(startCalls);
  expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: releaseMode });

  return lease.client;
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
    role: "transient",
  });
}
