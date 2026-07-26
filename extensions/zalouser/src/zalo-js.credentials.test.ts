// Zalouser tests cover zalo js.credentials plugin behavior.
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { API, LoginQRCallbackEvent } from "./zca-client.js";
import { LoginQRCallbackEventType } from "./zca-constants.js";

const createZaloMock = vi.hoisted(() => vi.fn());
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

vi.mock("./zca-client.js", () => ({
  createZalo: createZaloMock,
  TextStyle: { Indent: 9 },
}));

import { setZalouserRuntime } from "./runtime.js";
import {
  clearStoredZaloCredentials,
  loadStoredZaloCredentials,
  refreshStoredZaloCredentials,
  resolveLegacyZalouserCredentialsPath,
  saveStoredZaloCredentials,
  type StoredZaloCredentials,
} from "./session-state.js";
import {
  checkZaloAuthenticated,
  listZaloFriends,
  sendZaloLink,
  sendZaloReaction,
  startZaloQrLogin,
  waitForZaloQrLogin,
} from "./zalo-js.js";

async function readStoredCredentials(
  stateDir: string,
  profile: string,
): Promise<StoredZaloCredentials> {
  const stored = loadStoredZaloCredentials(profile, { OPENCLAW_STATE_DIR: stateDir });
  if (!stored) {
    throw new Error("Expected stored Zalo credentials");
  }
  return stored;
}

function seedStoredCredentials(
  stateDir: string,
  profile: string,
  credentials: Omit<StoredZaloCredentials, "profile">,
): void {
  saveStoredZaloCredentials(profile, credentials, { OPENCLAW_STATE_DIR: stateDir });
}

function createMockApi(params: {
  imei: string;
  userAgent: string;
  language?: string;
  cookies: unknown[] | (() => unknown[]);
  getAllFriends?: API["getAllFriends"];
}): API {
  return {
    getContext: () => ({
      imei: params.imei,
      userAgent: params.userAgent,
      language: params.language,
    }),
    getCookie: () => ({
      toJSON: () => ({
        cookies: typeof params.cookies === "function" ? params.cookies() : params.cookies,
      }),
    }),
    fetchAccountInfo: async () => ({
      userId: "user-1",
      username: "user-1",
      displayName: "Zalo User",
      zaloName: "Zalo User",
      avatar: "",
    }),
    getAllFriends: params.getAllFriends ?? vi.fn(async () => []),
    listener: {
      on: vi.fn(),
      off: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
  } as unknown as API;
}

describe("zalouser credential persistence", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("zalouser", options);
    setZalouserRuntime(runtime);
    createZaloMock.mockReset();
  });

  it("does not let a delayed credential refresh undo explicit logout", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const profile = "revoked-refresh";
    const stored = {
      imei: "device",
      cookie: [{ key: "zpsid", value: "old", domain: "chat.zalo.me" }],
      userAgent: "agent",
      createdAt: "2026-04-01T00:00:00.000Z",
    };
    try {
      saveStoredZaloCredentials(profile, stored, env);
      clearStoredZaloCredentials(profile, env);

      expect(
        refreshStoredZaloCredentials(
          profile,
          { ...stored, cookie: [{ key: "zpsid", value: "late", domain: "chat.zalo.me" }] },
          env,
        ),
      ).toBe(false);
      expect(loadStoredZaloCredentials(profile, env)).toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("persists the final API cookie jar after QR login", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "qr-refresh";
    const callbackCookie = [{ key: "zpsid", value: "callback", domain: "chat.zalo.me" }];
    const refreshedCookie = [{ key: "zpsid", value: "refreshed", domain: "chat.zalo.me" }];
    const api = createMockApi({
      imei: "api-imei",
      userAgent: "api-user-agent",
      language: "vi",
      cookies: refreshedCookie,
    });

    createZaloMock.mockResolvedValueOnce({
      loginQR: async (_options: unknown, callback?: (event: LoginQRCallbackEvent) => unknown) => {
        callback?.({
          type: LoginQRCallbackEventType.QRCodeGenerated,
          data: {
            code: "qr-code",
            image: "data:image/png;base64,abc123",
          },
          actions: {
            saveToFile: vi.fn(async () => undefined),
            retry: vi.fn(),
            abort: vi.fn(),
          },
        });
        callback?.({
          type: LoginQRCallbackEventType.GotLoginInfo,
          data: {
            cookie: callbackCookie,
            imei: "callback-imei",
            userAgent: "callback-user-agent",
          },
          actions: null,
        });
        return api;
      },
    });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await startZaloQrLogin({ profile, timeoutMs: 1000 });

        const loginResult = await waitForZaloQrLogin({ profile, timeoutMs: 1000 });
        expect(loginResult.connected).toBe(true);

        const stored = await readStoredCredentials(stateDir, profile);
        expect(stored.imei).toBe("api-imei");
        expect(stored.userAgent).toBe("api-user-agent");
        expect(stored.language).toBe("vi");
        expect(stored.cookie).toEqual(refreshedCookie);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("revalidates setup ownership immediately before QR credentials are written", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "qr-stale-owner";
    const guardError = new Error("verified inference changed");
    const beforeCredentialPersistence = vi.fn(async () => {
      throw guardError;
    });
    const api = createMockApi({
      imei: "api-imei",
      userAgent: "api-user-agent",
      cookies: [{ key: "zpsid", value: "stale-owner", domain: "chat.zalo.me" }],
    });

    createZaloMock.mockResolvedValueOnce({
      loginQR: async (_options: unknown, callback?: (event: LoginQRCallbackEvent) => unknown) => {
        callback?.({
          type: LoginQRCallbackEventType.QRCodeGenerated,
          data: {
            code: "qr-code",
            image: "data:image/png;base64,abc123",
          },
          actions: {
            saveToFile: vi.fn(async () => undefined),
            retry: vi.fn(),
            abort: vi.fn(),
          },
        });
        return api;
      },
    });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const started = await startZaloQrLogin({
          profile,
          timeoutMs: 1000,
          beforeCredentialPersistence,
        });
        const waited = await waitForZaloQrLogin({ profile, timeoutMs: 1000 });

        expect(`${started.message} ${waited.message}`).toContain(guardError.message);
        expect(beforeCredentialPersistence).toHaveBeenCalledTimes(1);
        expect(loadStoredZaloCredentials(profile)).toBeNull();
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("caps oversized QR start timeout before computing the polling deadline", async () => {
    let loginStarted = false;
    let postStartClockReads = 0;
    createZaloMock.mockImplementationOnce(async () => {
      loginStarted = true;
      return {
        loginQR: async () => new Promise(() => {}),
      };
    });
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      if (!loginStarted) {
        return 0;
      }
      return postStartClockReads++ === 0 ? 0 : MAX_TIMER_TIMEOUT_MS + 1;
    });
    try {
      const result = await startZaloQrLogin({
        profile: "qr-timeout-cap",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });

      expect(result.message).toBe(
        "Still preparing QR. Call wait to continue checking login status.",
      );
      expect(postStartClockReads).toBeGreaterThanOrEqual(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rewrites restored sessions with cookies refreshed by zca-js login", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "restore-refresh";
    const storedCookie = [{ key: "zpsid", value: "stored", domain: "chat.zalo.me" }];
    const refreshedCookie = [{ key: "zpsid", value: "refreshed", domain: "chat.zalo.me" }];
    seedStoredCredentials(stateDir, profile, {
      imei: "stored-imei",
      cookie: storedCookie,
      userAgent: "stored-user-agent",
      createdAt: "2026-04-01T00:00:00.000Z",
    });

    const api = createMockApi({
      imei: "stored-imei",
      userAgent: "stored-user-agent",
      language: "vi",
      cookies: refreshedCookie,
    });
    const login = vi.fn(async () => api);
    createZaloMock.mockResolvedValueOnce({ login });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(checkZaloAuthenticated(profile)).resolves.toBe(true);

        expect(login).toHaveBeenCalledWith({
          imei: "stored-imei",
          cookie: storedCookie,
          userAgent: "stored-user-agent",
          language: undefined,
        });
        const stored = await readStoredCredentials(stateDir, profile);
        expect(stored.cookie).toEqual(refreshedCookie);
        expect(stored.createdAt).toBe("2026-04-01T00:00:00.000Z");
        expect(stored.lastUsedAt).toMatch(ISO_TIMESTAMP_RE);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps setup-style read-only API calls from rewriting refreshed credentials", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "read-only-refresh";
    const storedCookie = [{ key: "zpsid", value: "stored", domain: "chat.zalo.me" }];
    const loginCookie = [{ key: "zpsid", value: "login", domain: "chat.zalo.me" }];
    const refreshedCookie = [{ key: "zpsid", value: "refreshed", domain: "chat.zalo.me" }];
    seedStoredCredentials(stateDir, profile, {
      imei: "stored-imei",
      cookie: storedCookie,
      userAgent: "stored-user-agent",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    const storedBefore = await readStoredCredentials(stateDir, profile);

    let currentCookie = loginCookie;
    const api = createMockApi({
      imei: "stored-imei",
      userAgent: "stored-user-agent",
      language: "vi",
      cookies: () => currentCookie,
      getAllFriends: vi.fn(async () => {
        currentCookie = refreshedCookie;
        return [];
      }),
    });
    createZaloMock.mockResolvedValueOnce({ login: vi.fn(async () => api) });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          listZaloFriends(profile, { credentialPersistence: "read-only" }),
        ).resolves.toStrictEqual([]);

        expect(await readStoredCredentials(stateDir, profile)).toEqual(storedBefore);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("persists cookie changes after a successful API call", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "api-refresh";
    const storedCookie: unknown[] = [{ key: "zpsid", value: "stored", domain: "chat.zalo.me" }];
    const loginCookie: unknown[] = [{ key: "zpsid", value: "login", domain: "chat.zalo.me" }];
    const refreshedCookie: unknown[] = [
      { key: "zpsid", value: "api-refreshed", domain: "chat.zalo.me" },
    ];
    seedStoredCredentials(stateDir, profile, {
      imei: "stored-imei",
      cookie: storedCookie,
      userAgent: "stored-user-agent",
      createdAt: "2026-04-01T00:00:00.000Z",
    });

    let currentCookie = loginCookie;
    const api = createMockApi({
      imei: "stored-imei",
      userAgent: "stored-user-agent",
      language: "vi",
      cookies: () => currentCookie,
      getAllFriends: vi.fn(async () => {
        currentCookie = refreshedCookie;
        return [
          {
            userId: "friend-1",
            username: "friend-1",
            displayName: "Friend One",
            zaloName: "Friend One",
            avatar: "",
          },
        ];
      }),
    });
    createZaloMock.mockResolvedValueOnce({ login: vi.fn(async () => api) });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(listZaloFriends(profile)).resolves.toEqual([
          {
            userId: "friend-1",
            displayName: "Friend One",
            avatar: undefined,
          },
        ]);

        const stored = await readStoredCredentials(stateDir, profile);
        expect(stored.cookie).toEqual(refreshedCookie);
        expect(stored.createdAt).toBe("2026-04-01T00:00:00.000Z");
        expect(stored.lastUsedAt).toMatch(ISO_TIMESTAMP_RE);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite credentials when the live cookie jar only reorders cookies", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "api-stable";
    const cookieA: unknown[] = [
      { key: "zpsid", value: "same", domain: "chat.zalo.me" },
      { key: "zpw", value: "same-secondary", domain: "chat.zalo.me" },
    ];
    const cookieB = [...cookieA].toReversed();
    seedStoredCredentials(stateDir, profile, {
      imei: "stored-imei",
      cookie: cookieA,
      userAgent: "stored-user-agent",
      createdAt: "2026-04-01T00:00:00.000Z",
    });

    let currentCookie = cookieA;
    const api = createMockApi({
      imei: "stored-imei",
      userAgent: "stored-user-agent",
      language: "vi",
      cookies: () => currentCookie,
      getAllFriends: vi.fn(async () => []),
    });
    createZaloMock.mockResolvedValueOnce({ login: vi.fn(async () => api) });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(listZaloFriends(profile)).resolves.toStrictEqual([]);
        const firstStored = await readStoredCredentials(stateDir, profile);

        currentCookie = cookieB;

        await expect(listZaloFriends(profile)).resolves.toStrictEqual([]);
        expect(await readStoredCredentials(stateDir, profile)).toEqual(firstStored);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  function expectMissingSessionResult(result: { ok: boolean; error?: string }) {
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No saved Zalo session");
  }

  it("keeps reaction sends non-throwing when session restore fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const result = await sendZaloReaction({
          profile: "missing-session",
          threadId: "thread-1",
          msgId: "msg-1",
          cliMsgId: "cli-1",
          emoji: "like",
        });
        expectMissingSessionResult(result);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps link sends non-throwing when session restore fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const result = await sendZaloLink("thread-1", "https://example.com", {
          profile: "missing-session",
        });
        expectMissingSessionResult(result);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("writes plugin-state SQLite without recreating the retired credential blob", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "sqlite-only";
    seedStoredCredentials(stateDir, profile, {
      imei: "api-imei",
      userAgent: "api-user-agent",
      cookie: [{ key: "zpsid", value: "sqlite", domain: "chat.zalo.me" }],
      createdAt: "2026-04-01T00:00:00.000Z",
    });

    try {
      await expect(
        access(resolveLegacyZalouserCredentialsPath(profile, { OPENCLAW_STATE_DIR: stateDir })),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(path.join(stateDir, "state", "openclaw.sqlite")),
      ).resolves.toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
