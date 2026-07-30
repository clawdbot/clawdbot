// Matrix tests cover SQLite-backed credentials behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasAnyMatrixAuth } from "../../auth-presence.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { openMatrixCredentialsStore } from "./credentials-read.js";
import {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  saveBackfilledMatrixDeviceId,
  saveMatrixCredentials,
  touchMatrixCredentials,
} from "./credentials.js";

type MatrixCredentials = NonNullable<ReturnType<typeof loadMatrixCredentials>>;

function expectMatrixCredentials(
  credentials: ReturnType<typeof loadMatrixCredentials>,
): MatrixCredentials {
  if (credentials === null) {
    throw new Error("Expected Matrix credentials");
  }
  expect(typeof credentials.createdAt).toBe("string");
  return credentials;
}

describe("matrix credentials storage", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-creds-"));
    installMatrixTestRuntime({ stateDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("roundtrips account-scoped credentials through shared plugin-state SQLite", async () => {
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

    expect(loadMatrixCredentials({}, "ops")).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      deviceId: "DEVICE123",
    });
    expect(loadMatrixCredentials({}, "default")).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "credentials", "matrix"))).toBe(false);
  });

  it("touch updates lastUsedAt while preserving createdAt", async () => {
    vi.useFakeTimers();
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
    const initial = expectMatrixCredentials(loadMatrixCredentials({}, "default"));

    vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
    await touchMatrixCredentials({}, "default");
    const touched = expectMatrixCredentials(loadMatrixCredentials({}, "default"));

    expect(touched.createdAt).toBe(initial.createdAt);
    expect(touched.lastUsedAt).toBe("2026-03-01T10:05:00.000Z");
  });

  it("omits an explicitly undefined device id from persisted credentials", async () => {
    const credentials = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      deviceId: undefined,
    };

    await saveMatrixCredentials(credentials, {}, "default");
    await expect(saveBackfilledMatrixDeviceId(credentials, {}, "ops")).resolves.toBe("saved");

    expect(openMatrixCredentialsStore({}).lookup("account:default")).not.toHaveProperty("deviceId");
    expect(openMatrixCredentialsStore({}).lookup("account:ops")).not.toHaveProperty("deviceId");
  });

  it("backfills a matching device id but preserves newer auth lineage", async () => {
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-new",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-new",
          deviceId: "DEVICE123",
        },
        {},
        "default",
      ),
    ).resolves.toBe("saved");
    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-old",
          deviceId: "STALE",
        },
        {},
        "default",
      ),
    ).resolves.toBe("skipped");

    expect(loadMatrixCredentials({}, "default")).toMatchObject({
      accessToken: "tok-new",
      deviceId: "DEVICE123",
    });
  });

  it("does not let delayed background writes undo credential revocation", async () => {
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "secret-token",
      },
      {},
      "default",
    );
    clearMatrixCredentials({}, "default");

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "secret-token",
          deviceId: "STALE",
        },
        {},
        "default",
      ),
    ).resolves.toBe("skipped");
    await touchMatrixCredentials({}, "default");

    expect(loadMatrixCredentials({}, "default")).toBeNull();
    expect(openMatrixCredentialsStore({}).lookup("account:default")).toMatchObject({
      kind: "revoked",
    });
  });

  it("does not read or remove legacy credential files at runtime", () => {
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
    );

    expect(loadMatrixCredentials({}, "default")).toBeNull();
    clearMatrixCredentials({}, "default");
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("clears only the requested canonical account", async () => {
    const credentials = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "token",
    };
    await saveMatrixCredentials(credentials, {}, "default");
    await saveMatrixCredentials(credentials, {}, "ops");

    clearMatrixCredentials({}, "ops");

    expect(loadMatrixCredentials({}, "ops")).toBeNull();
    expect(openMatrixCredentialsStore({}).lookup("account:ops")).toMatchObject({
      kind: "revoked",
      accountId: "ops",
    });
    expect(loadMatrixCredentials({}, "default")).not.toBeNull();
  });

  it("reports persisted auth from SQLite for package-state probes", async () => {
    const env = { OPENCLAW_STATE_DIR: stateDir };
    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(false);

    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
      },
      env,
      "default",
    );

    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(true);
  });

  it("requires a token match when userId is absent", () => {
    const stored = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      credentialsMatchConfig(stored, {
        homeserver: stored.homeserver,
        userId: "",
        accessToken: "tok-new",
      }),
    ).toBe(false);
    expect(
      credentialsMatchConfig(stored, {
        homeserver: stored.homeserver,
        userId: "",
        accessToken: "tok-123",
      }),
    ).toBe(true);
  });
});
