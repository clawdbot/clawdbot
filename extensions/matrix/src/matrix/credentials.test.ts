import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import {
  credentialsMatchConfig,
  loadMatrixCredentials,
  clearMatrixCredentials,
  resolveMatrixCredentialsPath,
  saveBackfilledMatrixDeviceId,
  saveMatrixCredentials,
  touchMatrixCredentials,
} from "./credentials.js";

const DEFAULT_LEGACY_CREDENTIALS = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "legacy-token",
  createdAt: "2026-03-01T10:00:00.000Z",
};

const EXPECTS_POSIX_PRIVATE_FILE_MODE = process.platform !== "win32";

type MatrixCredentials = NonNullable<ReturnType<typeof loadMatrixCredentials>>;

function expectMatrixCredentials(
  credentials: ReturnType<typeof loadMatrixCredentials>,
): MatrixCredentials {
  expect(credentials).toEqual(expect.objectContaining({ createdAt: expect.any(String) }));
  if (credentials === null) {
    throw new Error("Expected Matrix credentials");
  }
  return credentials;
}

describe("matrix credentials storage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupStateDir(
    cfg: Record<string, unknown> = {
      channels: {
        matrix: {},
      },
    },
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-creds-"));
    tempDirs.push(dir);
    installMatrixTestRuntime({ cfg, stateDir: dir });
    return dir;
  }

  function setupLegacyCredentialsFile(params: {
    cfg: Record<string, unknown>;
    accountId: string;
    credentials?: Record<string, unknown>;
  }) {
    const stateDir = setupStateDir(params.cfg);
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, params.accountId);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(params.credentials ?? DEFAULT_LEGACY_CREDENTIALS));
    return { stateDir, legacyPath, currentPath };
  }

  it("writes credentials atomically with secure file permissions", async () => {
    const stateDir = setupStateDir();
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "secret-token",
        deviceId: "DEVICE123",
      },
      {},
      "ops",
    );

    const credPath = resolveMatrixCredentialsPath({}, "ops");
    expect(fs.existsSync(credPath)).toBe(true);
    expect(credPath).toBe(path.join(stateDir, "credentials", "matrix", "credentials-ops.json"));
    const mode = fs.statSync(credPath).mode & 0o777;
    if (EXPECTS_POSIX_PRIVATE_FILE_MODE) {
      expect(mode).toBe(0o600);
    }
  });

  it("touch updates lastUsedAt while preserving createdAt", async () => {
    setupStateDir();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      await saveMatrixCredentials(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "secret-token",
        },
        {},
        "default",
      );
      const initial = loadMatrixCredentials({}, "default");
      const initialCredentials = expectMatrixCredentials(initial);

      vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
      await touchMatrixCredentials({}, "default");
      const touched = loadMatrixCredentials({}, "default");
      const touchedCredentials = expectMatrixCredentials(touched);

      expect(touchedCredentials.createdAt).toBe(initialCredentials.createdAt);
      expect(touchedCredentials.lastUsedAt).toBe("2026-03-01T10:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfill updates deviceId when credentials still match the same auth lineage", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
        },
        {},
        "default",
      ),
    ).resolves.toBe("saved");

    expect(loadMatrixCredentials({}, "default")).toMatchObject({
      accessToken: "tok-123",
      deviceId: "DEVICE123",
    });
  });

  it("backfill skips when newer credentials already changed the token", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-new",
        deviceId: "DEVICE999",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-old",
          deviceId: "DEVICE123",
        },
        {},
        "default",
      ),
    ).resolves.toBe("skipped");

    expect(loadMatrixCredentials({}, "default")).toMatchObject({
      accessToken: "tok-new",
      deviceId: "DEVICE999",
    });
  });

  it("serializes stale backfill writes behind newer credential saves", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-old",
      },
      {},
      "default",
    );

    let releaseFirstWrite: (() => void) | undefined;
    let resolveFirstWriteStarted: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      resolveFirstWriteStarted = resolve;
    });
    const originalRename = fsPromises.rename.bind(fsPromises);
    const renameSpy = vi
      .spyOn(fsPromises, "rename")
      .mockImplementation(async (...args: Parameters<typeof fsPromises.rename>) => {
        if (resolveFirstWriteStarted) {
          resolveFirstWriteStarted();
          resolveFirstWriteStarted = undefined;
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        await originalRename(...args);
      });

    try {
      const staleBackfillPromise = saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-old",
          deviceId: "DEVICE123",
        },
        {},
        "default",
      );

      await firstWriteStarted;

      const newerSavePromise = saveMatrixCredentials(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-new",
          deviceId: "DEVICE999",
        },
        {},
        "default",
      );

      releaseFirstWrite?.();
      await Promise.all([staleBackfillPromise, newerSavePromise]);

      expect(loadMatrixCredentials({}, "default")).toMatchObject({
        accessToken: "tok-new",
        deviceId: "DEVICE999",
      });
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("migrates legacy matrix credential files on read", () => {
    const { legacyPath, currentPath } = setupLegacyCredentialsFile({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
      accountId: "ops",
    });

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded?.accessToken).toBe("legacy-token");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(currentPath)).toBe(true);
  });

  it("returns migrated credentials when another process moves the legacy file mid-read", () => {
    const { legacyPath, currentPath } = setupLegacyCredentialsFile({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
      accountId: "ops",
    });

    const originalReadFileSync = fs.readFileSync.bind(fs);
    let moved = false;
    const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (!moved && filePath === legacyPath) {
        fs.renameSync(legacyPath, currentPath);
        moved = true;
      }
      return originalReadFileSync(filePath, options as never);
    }) as typeof fs.readFileSync);
    try {
      const loaded = loadMatrixCredentials({}, "ops");

      expect(loaded?.accessToken).toBe("legacy-token");
      expect(moved).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(currentPath)).toBe(true);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("does not rename the legacy path after falling back to already-migrated current credentials", () => {
    const { legacyPath, currentPath } = setupLegacyCredentialsFile({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
      accountId: "ops",
    });

    const originalReadFileSync = fs.readFileSync.bind(fs);
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync");
    let migrated = false;
    const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (!migrated && filePath === legacyPath && fs.existsSync(legacyPath)) {
        originalRenameSync(legacyPath, currentPath);
        fs.writeFileSync(
          currentPath,
          JSON.stringify({
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "current-token",
            createdAt: "2026-03-01T10:00:00.000Z",
          }),
        );
        migrated = true;
        try {
          return originalReadFileSync(filePath, options as never);
        } finally {
          fs.writeFileSync(
            legacyPath,
            JSON.stringify({
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "recreated-stale-legacy-token",
              createdAt: "2026-03-01T10:00:00.000Z",
            }),
          );
        }
      }
      return originalReadFileSync(filePath, options as never);
    }) as typeof fs.readFileSync);

    try {
      const loaded = loadMatrixCredentials({}, "ops");

      expect(loaded?.accessToken).toBe("current-token");
      expect(renameSpy).not.toHaveBeenCalled();
      expect(
        JSON.parse(fs.readFileSync(currentPath, "utf8")) as { accessToken: string },
      ).toMatchObject({
        accessToken: "current-token",
      });
      expect(
        JSON.parse(fs.readFileSync(legacyPath, "utf8")) as { accessToken: string },
      ).toMatchObject({
        accessToken: "recreated-stale-legacy-token",
      });
    } finally {
      readFileSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it("does not migrate legacy default credentials during a non-selected account read", () => {
    const { legacyPath, currentPath } = setupLegacyCredentialsFile({
      cfg: {
        channels: {
          matrix: {
            defaultAccount: "default",
            accounts: {
              default: {
                homeserver: "https://matrix.default.example.org",
                accessToken: "default-token",
              },
              ops: {},
            },
          },
        },
      },
      accountId: "ops",
      credentials: {
        homeserver: "https://matrix.default.example.org",
        userId: "@default:example.org",
        accessToken: "default-token",
        createdAt: "2026-03-01T10:00:00.000Z",
      },
    });

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded).toBeNull();
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(currentPath)).toBe(false);
  });

  it("migrates legacy credentials to the named account when top-level auth is only a shared default", () => {
    const { legacyPath, currentPath } = setupLegacyCredentialsFile({
      cfg: {
        channels: {
          matrix: {
            accessToken: "shared-token",
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      },
      accountId: "ops",
      credentials: {
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
      },
    });

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded?.accessToken).toBe("legacy-token");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(currentPath)).toBe(true);
  });

  it("clears both current and legacy credential paths", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    });
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(currentPath, "{}");
    fs.writeFileSync(legacyPath, "{}");

    clearMatrixCredentials({}, "ops");

    expect(fs.existsSync(currentPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("requires a token match when userId is absent", () => {
    expect(
      credentialsMatchConfig(
        {
          homeserver: "https://matrix.example.org",
          userId: "@old:example.org",
          accessToken: "tok-old",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          homeserver: "https://matrix.example.org",
          userId: "",
          accessToken: "tok-new",
        },
      ),
    ).toBe(false);

    expect(
      credentialsMatchConfig(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          homeserver: "https://matrix.example.org",
          userId: "",
          accessToken: "tok-123",
        },
      ),
    ).toBe(true);
  });
});
