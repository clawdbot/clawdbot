import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { API, Credentials, LoginQRCallbackEvent } from "./zca-client.js";
import { LoginQRCallbackEventType } from "./zca-constants.js";

const createZaloMock = vi.hoisted(() => vi.fn());
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

vi.mock("./zca-client.js", () => ({
  createZalo: createZaloMock,
  TextStyle: { Indent: 9 },
}));

import {
  checkZaloAuthenticated,
  listZaloFriends,
  sendZaloLink,
  sendZaloReaction,
  startZaloQrLogin,
  waitForZaloQrLogin,
} from "./zalo-js.js";

type StoredCredentialFile = {
  imei: string;
  cookie: Credentials["cookie"];
  userAgent: string;
  language?: string;
  createdAt?: string;
  lastUsedAt?: string;
};

function credentialPath(stateDir: string, profile: string): string {
  const trimmed = profile.trim().toLowerCase();
  const filename =
    !trimmed || trimmed === "default"
      ? "credentials.json"
      : `credentials-${encodeURIComponent(trimmed)}.json`;
  return path.join(stateDir, "credentials", "zalouser", filename);
}

async function readStoredCredentials(
  stateDir: string,
  profile: string,
): Promise<StoredCredentialFile> {
  return JSON.parse(
    await readFile(credentialPath(stateDir, profile), "utf8"),
  ) as StoredCredentialFile;
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
    createZaloMock.mockReset();
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

  it("rewrites restored sessions with cookies refreshed by zca-js login", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "restore-refresh";
    const storedCookie = [{ key: "zpsid", value: "stored", domain: "chat.zalo.me" }];
    const refreshedCookie = [{ key: "zpsid", value: "refreshed", domain: "chat.zalo.me" }];
    const filePath = credentialPath(stateDir, profile);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        {
          imei: "stored-imei",
          cookie: storedCookie,
          userAgent: "stored-user-agent",
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

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

  it("persists cookie changes after a successful API call", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
    const profile = "api-refresh";
    const storedCookie: unknown[] = [{ key: "zpsid", value: "stored", domain: "chat.zalo.me" }];
    const loginCookie: unknown[] = [{ key: "zpsid", value: "login", domain: "chat.zalo.me" }];
    const refreshedCookie: unknown[] = [
      { key: "zpsid", value: "api-refreshed", domain: "chat.zalo.me" },
    ];
    const filePath = credentialPath(stateDir, profile);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        {
          imei: "stored-imei",
          cookie: storedCookie,
          userAgent: "stored-user-agent",
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

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
    const filePath = credentialPath(stateDir, profile);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        {
          imei: "stored-imei",
          cookie: cookieA,
          userAgent: "stored-user-agent",
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

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
        const firstRaw = await readFile(filePath, "utf8");
        const stableMtime = new Date("2026-04-01T00:00:10.000Z");
        await utimes(filePath, stableMtime, stableMtime);
        const firstMtimeMs = (await stat(filePath)).mtimeMs;

        currentCookie = cookieB;

        await expect(listZaloFriends(profile)).resolves.toStrictEqual([]);
        expect(await readFile(filePath, "utf8")).toBe(firstRaw);
        expect((await stat(filePath)).mtimeMs).toBe(firstMtimeMs);
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

  it.skipIf(process.platform === "win32")(
    "writes credentials with private permissions",
    async () => {
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
      const profile = "private-mode";
      const api = createMockApi({
        imei: "api-imei",
        userAgent: "api-user-agent",
        cookies: [{ key: "zpsid", value: "private", domain: "chat.zalo.me" }],
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
          await startZaloQrLogin({ profile, timeoutMs: 1000 });
          const loginResult = await waitForZaloQrLogin({ profile, timeoutMs: 1000 });
          expect(loginResult.connected).toBe(true);

          const filePath = credentialPath(stateDir, profile);
          const dirMode = (await stat(path.dirname(filePath))).mode & 0o777;
          const fileMode = (await stat(filePath)).mode & 0o777;
          expect(dirMode).toBe(0o700);
          expect(fileMode).toBe(0o600);
        });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to write credentials through a symlinked file",
    async () => {
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-credentials-"));
      const profile = "symlink-target";
      const filePath = credentialPath(stateDir, profile);
      const targetPath = path.join(stateDir, "outside.json");
      const api = createMockApi({
        imei: "api-imei",
        userAgent: "api-user-agent",
        cookies: [{ key: "zpsid", value: "symlink", domain: "chat.zalo.me" }],
      });

      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(targetPath, "sentinel", "utf8");
      await symlink(targetPath, filePath);

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
          const started = await startZaloQrLogin({ profile, timeoutMs: 1000 });
          const waited = await waitForZaloQrLogin({ profile, timeoutMs: 1000 });
          expect(`${started.message} ${waited.message}`).toMatch(
            /Refusing to write Zalo credentials to symlinked path|private store target must be a regular file/,
          );
        });

        expect(await readFile(targetPath, "utf8")).toBe("sentinel");
        expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
