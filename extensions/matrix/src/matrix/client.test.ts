import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig } from "../types.js";
import {
  backfillMatrixAuthDeviceIdAfterStartup,
  resolveMatrixAuth,
  setMatrixAuthClientDepsForTest,
} from "./client/config.js";
import * as credentialsReadModule from "./credentials-read.js";

const saveMatrixCredentialsMock = vi.hoisted(() => vi.fn());
const saveBackfilledMatrixDeviceIdMock = vi.hoisted(() => vi.fn(async () => "saved"));
const touchMatrixCredentialsMock = vi.hoisted(() => vi.fn());
const repairCurrentTokenStorageMetaDeviceIdMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputStringMock = vi.hoisted(() => vi.fn());

vi.mock("./credentials-read.js", () => ({
  loadMatrixCredentials: vi.fn(() => null),
  credentialsMatchConfig: vi.fn(() => false),
}));

vi.mock("./credentials-write.runtime.js", () => ({
  saveBackfilledMatrixDeviceId: saveBackfilledMatrixDeviceIdMock,
  saveMatrixCredentials: saveMatrixCredentialsMock,
  touchMatrixCredentials: touchMatrixCredentialsMock,
}));

vi.mock("./client/storage.js", async () => {
  const actual = await vi.importActual<typeof import("./client/storage.js")>("./client/storage.js");
  return {
    ...actual,
    repairCurrentTokenStorageMetaDeviceId: repairCurrentTokenStorageMetaDeviceIdMock,
  };
});

vi.mock("./client/config-secret-input.runtime.js", () => ({
  resolveConfiguredSecretInputString: resolveConfiguredSecretInputStringMock,
}));

const ensureMatrixSdkLoggingConfiguredMock = vi.fn();
const matrixDoRequestMock = vi.fn();

class MockMatrixClient {
  async doRequest(...args: unknown[]) {
    return await matrixDoRequestMock(...args);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectAuthFields(auth: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(auth, "Matrix auth"), fields);
}

function mockCall(mock: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`missing mock call ${index}`);
  }
  return call;
}

function expectSavedCredentials(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
  accountId: string,
) {
  const call = mockCall(mock);
  expectRecordFields(requireRecord(call[0], "Matrix credentials"), fields);
  requireRecord(call[1], "Matrix credential save options");
  expect(call[2]).toBe(accountId);
}

function expectMatrixLoginCall(fields: Record<string, unknown>) {
  const call = mockCall(matrixDoRequestMock);
  expect(call[0]).toBe("POST");
  expect(call[1]).toBe("/_matrix/client/v3/login");
  expect(call[2]).toBeUndefined();
  expectRecordFields(requireRecord(call[3], "Matrix login body"), fields);
}

describe("resolveMatrixAuth", () => {
  beforeEach(() => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReset();
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue(null);
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReset();
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(false);
    saveMatrixCredentialsMock.mockReset();
    saveBackfilledMatrixDeviceIdMock.mockReset().mockResolvedValue("saved");
    touchMatrixCredentialsMock.mockReset();
    repairCurrentTokenStorageMetaDeviceIdMock.mockReset().mockReturnValue(true);
    resolveConfiguredSecretInputStringMock.mockReset().mockResolvedValue({});
    ensureMatrixSdkLoggingConfiguredMock.mockReset();
    matrixDoRequestMock.mockReset();
    setMatrixAuthClientDepsForTest({
      MatrixClient: MockMatrixClient as unknown as typeof import("./sdk.js").MatrixClient,
      ensureMatrixSdkLoggingConfigured: ensureMatrixSdkLoggingConfiguredMock,
      retryMinDelayMs: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setMatrixAuthClientDepsForTest(undefined);
  });

  it("uses the hardened client request path for password login and persists deviceId", async () => {
    matrixDoRequestMock.mockResolvedValue({
      access_token: "tok-123",
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expectMatrixLoginCall({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "@bot:example.org" },
      password: "secret",
    });
    expectAuthFields(auth, {
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
    expectSavedCredentials(
      saveMatrixCredentialsMock,
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      },
      "default",
    );
  });

  it("surfaces password login errors when account credentials are invalid", async () => {
    matrixDoRequestMock.mockRejectedValueOnce(new Error("Invalid username or password"));

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    await expect(
      resolveMatrixAuth({
        cfg,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow("Invalid username or password");

    expectMatrixLoginCall({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "@bot:example.org" },
      password: "secret",
    });
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("uses cached matching credentials when access token is not configured", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expectAuthFields(auth, {
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
    });
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("uses cached matching credentials for env-backed named accounts without fresh auth", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_USER_ID: "@ops:example.org",
    } as NodeJS.ProcessEnv;

    const auth = await resolveMatrixAuth({
      cfg,
      env,
      accountId: "ops",
    });

    expectAuthFields(auth, {
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
    });
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("rejects embedded credentials in Matrix homeserver URLs", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://user:pass@matrix.example.org",
          accessToken: "tok-123",
        },
      },
    } as CoreConfig;

    await expect(resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      "Matrix homeserver URL must not include embedded credentials",
    );
  });

  it("falls back to config deviceId when cached credentials are missing it", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth.deviceId).toBe("DEVICE123");
    expect(auth.accountId).toBe("default");
    expectSavedCredentials(
      saveMatrixCredentialsMock,
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      },
      "default",
    );
  });

  it("carries the private-network opt-in through Matrix auth resolution", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "http://127.0.0.1:8008",
          allowPrivateNetwork: true,
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expectAuthFields(auth, {
      homeserver: "http://127.0.0.1:8008",
      allowPrivateNetwork: true,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("resolves token-only non-default account userId from whoami instead of inheriting the base user", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          userId: "@base:example.org",
          homeserver: "https://matrix.example.org",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expect(auth.userId).toBe("@ops:example.org");
    expect(auth.deviceId).toBe("OPSDEVICE");
  });

  it("uses named-account password auth instead of inheriting the base access token", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue(null);
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(false);
    matrixDoRequestMock.mockResolvedValue({
      access_token: "ops-token",
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "legacy-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
              password: "ops-pass", // pragma: allowlist secret
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expectMatrixLoginCall({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "@ops:example.org" },
      password: "ops-pass",
    });
    expectAuthFields(auth, {
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
    });
  });

  it("resolves missing whoami identity fields for token auth", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expectAuthFields(auth, {
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
  });

  it("retries token whoami when startup auth hits a transient network error", async () => {
    matrixDoRequestMock
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
          }),
        }),
      )
      .mockResolvedValue({
        user_id: "@bot:example.org",
        device_id: "DEVICE123",
      });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-123",
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledTimes(2);
    expectAuthFields(auth, {
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
    });
  });

  it("does not call whoami when token auth already has a userId and only deviceId is missing", async () => {
    matrixDoRequestMock.mockRejectedValue(new Error("whoami should not be called"));

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).not.toHaveBeenCalled();
    expectAuthFields(auth, {
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: undefined,
      encryption: true,
    });
  });

  it("retries password login when startup auth hits a transient network error", async () => {
    matrixDoRequestMock
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("socket hang up"), {
            code: "ECONNRESET",
          }),
        }),
      )
      .mockResolvedValue({
        access_token: "tok-123",
        user_id: "@bot:example.org",
        device_id: "DEVICE123",
      });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledTimes(2);
    expectAuthFields(auth, {
      accessToken: "tok-123",
      deviceId: "DEVICE123",
    });
  });

  it("best-effort backfills a missing deviceId after startup", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const deviceId = await backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expectSavedCredentials(
      saveBackfilledMatrixDeviceIdMock,
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      },
      "default",
    );
    const repairMeta = requireRecord(
      mockCall(repairCurrentTokenStorageMetaDeviceIdMock).at(0),
      "repair metadata",
    );
    expectRecordFields(repairMeta, {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      accountId: "default",
      deviceId: "DEVICE123",
    });
    requireRecord(repairMeta.env, "repair env");
    expect(repairCurrentTokenStorageMetaDeviceIdMock.mock.invocationCallOrder[0]).toBeLessThan(
      saveBackfilledMatrixDeviceIdMock.mock.invocationCallOrder[0],
    );
    expect(deviceId).toBe("DEVICE123");
  });

  it("skips deviceId backfill when auth already includes it", async () => {
    const deviceId = await backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).not.toHaveBeenCalled();
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
    expect(repairCurrentTokenStorageMetaDeviceIdMock).not.toHaveBeenCalled();
    expect(deviceId).toBe("DEVICE123");
  });

  it("fails before saving repaired credentials when storage metadata repair fails", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });
    repairCurrentTokenStorageMetaDeviceIdMock.mockReturnValue(false);

    await expect(
      backfillMatrixAuthDeviceIdAfterStartup({
        auth: {
          accountId: "default",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow("Matrix deviceId backfill failed to repair current-token storage metadata");
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
  });

  it("skips stale deviceId backfill writes after newer credentials take over", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-new",
      deviceId: "DEVICE999",
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    const deviceId = await backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-old",
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(deviceId).toBeUndefined();
    expect(repairCurrentTokenStorageMetaDeviceIdMock).not.toHaveBeenCalled();
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
  });

  it("skips persistence when startup backfill is aborted before whoami resolves", async () => {
    let resolveWhoami: ((value: { user_id: string; device_id: string }) => void) | undefined;
    matrixDoRequestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWhoami = resolve;
        }),
    );
    const abortController = new AbortController();
    const backfillPromise = backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
      env: {} as NodeJS.ProcessEnv,
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(resolveWhoami).toBeTypeOf("function");
    });
    abortController.abort();
    resolveWhoami?.({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    await expect(backfillPromise).resolves.toBeUndefined();
    expect(repairCurrentTokenStorageMetaDeviceIdMock).not.toHaveBeenCalled();
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
  });

  it("resolves configured accessToken SecretRefs during Matrix auth", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });
    resolveConfiguredSecretInputStringMock.mockResolvedValue({ value: "resolved-token" });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: { source: "file", provider: "matrix-file", id: "value" },
        },
      },
      secrets: {
        providers: {
          "matrix-file": {
            source: "file",
            path: "/tmp/matrix-token.txt",
            mode: "singleValue",
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expectRecordFields(
      requireRecord(mockCall(resolveConfiguredSecretInputStringMock).at(0), "secret request"),
      {
        config: cfg,
        value: { source: "file", provider: "matrix-file", id: "value" },
        path: "channels.matrix.accessToken",
      },
    );
    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expectAuthFields(auth, {
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "resolved-token",
      deviceId: "DEVICE123",
    });
  });

  it("does not resolve inactive password SecretRefs when scoped token auth wins", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              password: { source: "env", provider: "default", id: "MATRIX_OPS_PASSWORD" },
            },
          },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    } as CoreConfig;

    installMatrixTestRuntime({ cfg });

    const auth = await resolveMatrixAuth({
      cfg,
      env: {
        MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      } as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expectAuthFields(auth, {
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
      password: undefined,
    });
  });

  it("uses config deviceId with cached credentials when token is loaded from cache", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          deviceId: "DEVICE123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expectAuthFields(auth, {
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
  });

  it("falls back to the sole configured account when no global homeserver is set", async () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
              deviceId: "OPSDEVICE",
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expectAuthFields(auth, {
      accountId: "ops",
      homeserver: "https://ops.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
      encryption: true,
    });
    expectSavedCredentials(
      saveMatrixCredentialsMock,
      {
        homeserver: "https://ops.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
        deviceId: "OPSDEVICE",
      },
      "ops",
    );
  });
});
